const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const gatewayClient = require('./tokenFreeGatewayService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TOOL_DIR = path.resolve(
  process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || path.join(PROJECT_ROOT, '.tools/token-free-gateway')
);
const ENTRY_FILE = path.join(TOOL_DIR, 'index.ts');
const CHROME_LINUX_CANDIDATES = [
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function localizarBun() {
  const configurado = String(process.env.BUN_PATH || '').trim();
  if (configurado) return configurado;

  const candidatos = process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
        path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
      ]
    : [path.join(os.homedir(), '.bun', 'bin', 'bun')];
  return candidatos.find((candidato) => candidato && fs.existsSync(candidato)) || 'bun';
}

const BUN_PATH = localizarBun();
const DATA_DIR = path.join(os.homedir(), '.token-free-gateway');
const AUTH_FILE = process.env.TFG_STORE_PATH || path.join(DATA_DIR, 'auth-profiles.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'gateway.log');
const CLEAR_SESSION_SCRIPT = path.join(PROJECT_ROOT, 'scripts/token-free-clear-claude-session.ts');

const AUTH_TIMEOUT_MS = 6 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 45 * 1000;
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_NOVNC_PORT = 6080;

const WEB_PROVIDERS = {
  claude: {
    profileId: 'claude-web',
    menuSelection: '1',
    label: 'Claude',
    loginUrl: 'https://claude.ai/new',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-sonnet-4-20250514', 'claude-sonnet-4-6'],
  },
  openai: {
    profileId: 'chatgpt-web',
    menuSelection: '2',
    label: 'ChatGPT',
    loginUrl: 'https://chatgpt.com/',
    defaultModel: 'gpt-4',
    models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  deepseek: {
    profileId: 'deepseek-web',
    menuSelection: '3',
    label: 'DeepSeek',
    loginUrl: 'https://chat.deepseek.com/',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  grok: {
    profileId: 'grok-web',
    menuSelection: '8',
    label: 'Grok',
    loginUrl: 'https://grok.com/',
    defaultModel: 'grok-2',
    models: ['grok-1', 'grok-2'],
  },
};

function providerInfo(value = 'claude') {
  const id = String(value || 'claude').trim().toLowerCase();
  const info = WEB_PROVIDERS[id];
  if (info) return { id, ...info };
  const err = new Error('Provedor web inválido.');
  err.status = 400;
  throw err;
}

let authJob = {
  status: 'idle',
  provider: null,
  providerLabel: null,
  message: 'Nenhuma autorização em andamento.',
  startedAt: null,
  finishedAt: null,
};
let activeAuthChild = null;
let activeAuthTimer = null;

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function lerJsonSeguro(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function authMetadata() {
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  const result = {};
  for (const [provider, info] of Object.entries(WEB_PROVIDERS)) {
    const profile = store?.profiles?.[info.profileId];
    result[provider] = {
      autorizada: Boolean(profile?.credentials && Object.keys(profile.credentials).length),
      atualizadaEm: isoDate(profile?.updatedAt),
    };
  }
  return result;
}

async function configMetadata() {
  const config = await lerJsonSeguro(CONFIG_FILE, {});
  return {
    porta: Number(config.port) || 3456,
    cdpUrl: String(config.cdpUrl || 'http://127.0.0.1:9222'),
    apiKeyProtegida: Boolean(String(process.env.TFG_API_KEY || config.apiKey || '').trim()),
    timeoutSegundos: Number(config.requestTimeoutSec) || 300,
  };
}

function authJobPublico() {
  return {
    status: authJob.status,
    provider: authJob.provider || null,
    providerLabel: authJob.providerLabel || null,
    message: authJob.message,
    startedAt: authJob.startedAt,
    finishedAt: authJob.finishedAt,
  };
}

function estaDentroDaPasta(pasta, arquivo) {
  const relativo = path.relative(path.resolve(pasta), path.resolve(arquivo));
  return relativo === '' || (!relativo.startsWith('..') && !path.isAbsolute(relativo));
}

function portaLocalAberta(porta, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: porta });
    let concluido = false;
    const finalizar = (online) => {
      if (concluido) return;
      concluido = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finalizar(true));
    socket.once('timeout', () => finalizar(false));
    socket.once('error', () => finalizar(false));
  });
}

function destinoSshDesktop() {
  const configurado = String(process.env.CLAUDE_SSH_TARGET || '').trim();
  if (configurado) return configurado;
  let host = 'SEU-SERVIDOR';
  try {
    host = new URL(process.env.APP_PUBLIC_URL || '').hostname || host;
  } catch {
    // Mantém o texto genérico quando APP_PUBLIC_URL não for uma URL válida.
  }
  return `${os.userInfo().username}@${host}`;
}

async function desktopMetadata() {
  const portaConfigurada = Number(process.env.CLAUDE_NOVNC_PORT);
  const porta = Number.isInteger(portaConfigurada) && portaConfigurada > 0
    ? portaConfigurada
    : DEFAULT_NOVNC_PORT;
  const online = process.platform === 'linux' ? await portaLocalAberta(porta) : false;
  return {
    necessario: process.platform === 'linux',
    configurado: process.platform !== 'linux' || Boolean(process.env.DISPLAY),
    online,
    display: String(process.env.DISPLAY || ''),
    porta,
    urlLocal: `http://127.0.0.1:${porta}/vnc.html?autoconnect=1&resize=remote&reconnect=1`,
    comandoSsh: `ssh -N -L ${porta}:127.0.0.1:${porta} ${destinoSshDesktop()}`,
  };
}

async function status() {
  const [auth, config, desktop] = await Promise.all([
    authMetadata(),
    configMetadata(),
    desktopMetadata(),
  ]);
  let health = null;
  let healthError = null;
  let modelos = [];

  try {
    health = await gatewayClient.verificarSaude({ timeout: 3_500 });
    try {
      modelos = await gatewayClient.listarModelos({ timeout: 3_500 });
    } catch {
      modelos = [];
    }
  } catch (err) {
    healthError = err.message;
  }

  const providerStatuses = {};
  for (const [provider, info] of Object.entries(WEB_PROVIDERS)) {
    const session = health?.sessions?.[info.profileId];
    providerStatuses[provider] = {
      provider,
      label: info.label,
      profileId: info.profileId,
      autorizada: Boolean(auth?.[provider]?.autorizada),
      atualizadaEm: auth?.[provider]?.atualizadaEm || null,
      valida: session?.valid === true ? true : session?.valid === false ? false : null,
      motivo: session?.reason || null,
      models: modelos
        .filter((item) => info.models.includes(String(item?.id || '')))
        .map((item) => ({ id: String(item.id), name: item.name || item.id })),
      defaultModel: info.defaultModel,
    };
  }
  const sessao = health?.sessions?.['claude-web'];
  const modeloConfigurado = gatewayClient.MODELO;
  const modeloDisponivel = modelos.some((item) => String(item?.id || '') === modeloConfigurado);

  return {
    gateway: {
      online: Boolean(health),
      status: health?.status || 'offline',
      erro: healthError,
      url: gatewayClient.BASE_URL,
      cliDisponivel: fs.existsSync(ENTRY_FILE),
      plataforma: process.platform,
    },
    chrome: {
      conectado: health?.browser === 'connected',
      cdpUrl: config.cdpUrl,
    },
    desktop,
    providers: providerStatuses,
    claude: {
      autorizada: auth.claude?.autorizada,
      atualizadaEm: auth.claude?.atualizadaEm,
      valida: sessao?.valid === true ? true : sessao?.valid === false ? false : null,
      motivo: sessao?.reason || null,
      modelo: modeloConfigurado,
      modeloDisponivel,
    },
    seguranca: {
      apiKeyProtegida: config.apiKeyProtegida,
      credencialForaDoPublico: !estaDentroDaPasta(path.join(PROJECT_ROOT, 'public'), AUTH_FILE),
    },
    autorizacao: authJobPublico(),
  };
}

function executar(executavel, args, { cwd = PROJECT_ROOT, timeout = COMMAND_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executavel, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
    });
    let output = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      const err = new Error(`Operação excedeu ${Math.round(timeout / 1000)} segundos.`);
      err.status = 504;
      reject(err);
    }, timeout);

    const guardar = (atual, chunk) => `${atual}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
    child.stdout?.on('data', (chunk) => {
      output = guardar(output, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = guardar(stderr, chunk);
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ output, stderr });
      const detalhe = String(stderr || output || `código ${code}`).replace(/\s+/g, ' ').trim();
      const err = new Error(`Comando do gateway falhou: ${detalhe.slice(0, 500)}`);
      err.status = 502;
      reject(err);
    });
  });
}

function assertCli() {
  if (fs.existsSync(ENTRY_FILE)) return;
  const err = new Error(
    'Código-fonte do token-free-gateway não encontrado em .tools/token-free-gateway.'
  );
  err.status = 503;
  throw err;
}

async function aguardarChromeCdp(timeout = 20_000) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    try {
      const response = await axios.get('http://127.0.0.1:9222/json/version', { timeout: 1_000 });
      if (response.status === 200) return true;
    } catch {
      // O Chrome ainda está iniciando.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function iniciarChromeVisualServidor(startUrl = WEB_PROVIDERS.claude.loginUrl) {
  const chromePath = CHROME_LINUX_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) {
    const err = new Error('Google Chrome/Chromium não encontrado no servidor.');
    err.status = 503;
    throw err;
  }

  const userDataDir = path.join(os.homedir(), '.config', 'chrome-tfg-debug');
  fs.mkdirSync(userDataDir, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const chromeLog = path.join(DATA_DIR, 'chrome.log');
  const logFd = fs.openSync(chromeLog, 'a');
  const flags = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--password-store=basic',
    '--remote-allow-origins=*',
    '--window-size=1440,1000',
    startUrl,
  ];

  try {
    const chrome = spawn(chromePath, flags, {
      cwd: os.homedir(),
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    chrome.unref();
  } finally {
    fs.closeSync(logFd);
  }

  if (!(await aguardarChromeCdp())) {
    const err = new Error(`Chrome visual não iniciou no DISPLAY ${process.env.DISPLAY}. Consulte ${chromeLog}.`);
    err.status = 502;
    throw err;
  }
}

async function comandoGateway(command) {
  assertCli();
  return executar(BUN_PATH, [ENTRY_FILE, command], { cwd: TOOL_DIR });
}

async function iniciar() {
  await comandoGateway('start');
  return { ok: true, message: 'Gateway iniciado.' };
}

async function reiniciar() {
  await comandoGateway('restart');
  return { ok: true, message: 'Gateway reiniciado.' };
}

async function removerCredencialProvider(provider = 'claude') {
  const info = providerInfo(provider);
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  if (!store.profiles[info.profileId]) return false;
  delete store.profiles[info.profileId];
  await fsp.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  const tempPath = `${AUTH_FILE}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, AUTH_FILE);
  return true;
}

async function limparSessaoClaudeDoChrome() {
  assertCli();
  if (!fs.existsSync(CLEAR_SESSION_SCRIPT)) {
    const err = new Error('Script seguro para troca da conta do Claude não foi encontrado.');
    err.status = 500;
    throw err;
  }

  // Garante que o Chrome isolado/CDP esteja aberto antes de apagar os cookies.
  await executar(BUN_PATH, [ENTRY_FILE, 'chrome', 'start'], {
    cwd: TOOL_DIR,
    timeout: COMMAND_TIMEOUT_MS,
  });
  await executar(BUN_PATH, [CLEAR_SESSION_SCRIPT], {
    cwd: PROJECT_ROOT,
    timeout: COMMAND_TIMEOUT_MS,
    env: { TOKEN_FREE_GATEWAY_SOURCE_DIR: TOOL_DIR },
  });
  await removerCredencialProvider('claude');
}

function iniciarAutorizacao({ provider = 'claude', trocarConta = false } = {}) {
  const providerConfig = providerInfo(provider);
  assertCli();
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const err = new Error(
      'Desktop privado não configurado. Instale o desktop e recarregue o PM2 antes de conectar a conta.'
    );
    err.status = 409;
    throw err;
  }
  if (['running', 'waiting_login', 'waiting_browser_login'].includes(authJob.status)) {
    const err = new Error('Já existe uma autorização de IA em andamento.');
    err.status = 409;
    throw err;
  }

  authJob = {
    status: 'running',
    provider: providerConfig.id,
    providerLabel: providerConfig.label,
    message: trocarConta
      ? `Preparando o Chrome para entrar em outra conta ${providerConfig.label}…`
      : `Abrindo o Chrome do servidor para conectar ${providerConfig.label}…`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  // O endpoint responde imediatamente. A tela acompanha este trabalho por polling.
  void (async () => {
    try {
      if (trocarConta && providerConfig.id === 'claude') await limparSessaoClaudeDoChrome();
      else if (trocarConta) await removerCredencialProvider(providerConfig.id);

      // Faz o webauth abrir uma janela nova e aguardar a confirmação manual.
      // Sem isso, um Chrome já aberto tentaria capturar a sessão imediatamente.
      await executar(BUN_PATH, [ENTRY_FILE, 'chrome', 'stop'], {
        cwd: TOOL_DIR,
        timeout: COMMAND_TIMEOUT_MS,
      });

      // Em produção, abre o Chrome no Xvfb antes do webauth. Assim o wizard
      // encontra o CDP pronto, pula a confirmação genérica de terminal e
      // aguarda diretamente o login do Claude no desktop privado.
      if (process.platform === 'linux' && process.env.DISPLAY) {
        authJob = {
          ...authJob,
          message: 'Iniciando o Chrome no desktop privado…',
        };
        await iniciarChromeVisualServidor(providerConfig.loginUrl);
      }

      const child = spawn(BUN_PATH, [ENTRY_FILE, 'webauth'], {
        cwd: TOOL_DIR,
        env: process.env,
        windowsHide: true,
        shell: false,
      });
      activeAuthChild = child;
      let buffer = '';
      let detectouPromptInicial = false;
      let detectouPromptProvider = false;
      let enviouProvider = false;
      let concluida = false;

      activeAuthTimer = setTimeout(() => {
        child.kill();
        activeAuthChild = null;
        activeAuthTimer = null;
        authJob = {
          ...authJob,
          status: 'error',
          message: 'O login não foi concluído em 6 minutos. Tente novamente.',
          finishedAt: new Date().toISOString(),
        };
      }, AUTH_TIMEOUT_MS);

      const analisar = (chunk) => {
        buffer = `${buffer}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
        if (!detectouPromptInicial && /Please log in[\s\S]*press Enter to continue/i.test(buffer)) {
          detectouPromptInicial = true;
          authJob = {
            ...authJob,
            status: 'waiting_login',
            message: `Chrome aberto no desktop privado. Entre no ${providerConfig.label} e depois clique em “Já entrei, concluir”.`,
          };
        }
        if (!detectouPromptProvider && /Please (?:log(?:in| in)|sign in) to/i.test(buffer)) {
          detectouPromptProvider = true;
          authJob = {
            ...authJob,
            status: 'waiting_browser_login',
            message: `Aguardando ${providerConfig.label} confirmar a sessão no Chrome…`,
          };
        }
        if (!enviouProvider && /Enter selection:/i.test(buffer)) {
          enviouProvider = true;
          child.stdin?.write(`${providerConfig.menuSelection}\n`);
          authJob = {
            ...authJob,
            status: 'waiting_browser_login',
            message: `Entre no ${providerConfig.label} pelo desktop privado. A sessão será capturada automaticamente…`,
          };
        }
        if (/authorization succeeded/i.test(buffer)) concluida = true;
      };

      child.stdout.on('data', analisar);
      child.stderr.on('data', analisar);
      child.on('error', (err) => {
        if (activeAuthTimer) clearTimeout(activeAuthTimer);
        activeAuthTimer = null;
        activeAuthChild = null;
        authJob = {
          ...authJob,
          status: 'error',
          message: `Não foi possível abrir a autorização: ${err.message}`,
          finishedAt: new Date().toISOString(),
        };
      });
      child.on('close', async () => {
        if (activeAuthTimer) clearTimeout(activeAuthTimer);
        activeAuthTimer = null;
        activeAuthChild = null;
        if (!['running', 'waiting_login', 'waiting_browser_login'].includes(authJob.status)) return;
        if (!concluida) {
          authJob = {
            ...authJob,
            status: 'error',
            message: `${providerConfig.label} não confirmou a nova sessão. Abra o desktop e tente novamente.`,
            finishedAt: new Date().toISOString(),
          };
          return;
        }

        authJob = {
          ...authJob,
          message: 'Sessão salva. Reiniciando o gateway…',
        };
        try {
          await reiniciar();
          authJob = {
            ...authJob,
            status: 'success',
            message: `${providerConfig.label} conectado e gateway reiniciado com sucesso.`,
            finishedAt: new Date().toISOString(),
          };
        } catch (err) {
          authJob = {
            ...authJob,
            status: 'error',
            message: `Sessão salva, mas o gateway não reiniciou: ${err.message}`,
            finishedAt: new Date().toISOString(),
          };
        }
      });
    } catch (err) {
      authJob = {
        ...authJob,
        status: 'error',
        message: err.message || 'Falha ao iniciar a autorização.',
        finishedAt: new Date().toISOString(),
      };
    }
  })();

  return authJobPublico();
}

function continuarAutorizacao() {
  if (authJob.status !== 'waiting_login' || !activeAuthChild?.stdin) {
    const err = new Error('Não existe um login aguardando confirmação.');
    err.status = 409;
    throw err;
  }

  authJob = {
    ...authJob,
    status: 'running',
    message: `Confirmando o login e capturando a sessão de ${authJob.providerLabel || 'IA'}…`,
  };
  activeAuthChild.stdin.write('\n');
  return authJobPublico();
}

async function testar({ provider = 'claude', model = null } = {}) {
  const providerConfig = providerInfo(provider);
  const selectedModel = String(model || providerConfig.defaultModel).trim();
  const inicio = Date.now();
  try {
    const { data } = await axios.post(
      `${gatewayClient.BASE_URL}/chat/completions`,
      {
        model: selectedModel,
        messages: [{ role: 'user', content: 'Responda somente com OK.' }],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TOKEN_FREE_GATEWAY_API_KEY || 'qualquer-coisa'}`,
          'Content-Type': 'application/json',
        },
        timeout: 45_000,
      }
    );
    const resposta = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!resposta) {
      const err = new Error(`${providerConfig.label} respondeu sem conteúdo.`);
      err.status = 502;
      throw err;
    }
    return {
      ok: true,
      message: `${providerConfig.label} respondeu em ${((Date.now() - inicio) / 1000).toFixed(1)}s.`,
      resposta: resposta.slice(0, 80),
    };
  } catch (err) {
    if (err.status) throw err;
    const remoto = String(
      err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err.message ||
        'erro desconhecido'
    )
      .replace(/\s+/g, ' ')
      .trim();
    const falha = new Error(`Teste do ${providerConfig.label} falhou: ${remoto.slice(0, 500)}`);
    falha.status = Number(err?.response?.status) || 502;
    throw falha;
  }
}

async function providerSessions() {
  const auth = await authMetadata();
  const result = {};
  for (const [provider, info] of Object.entries(WEB_PROVIDERS)) {
    result[provider] = {
      provider,
      label: info.label,
      profileId: info.profileId,
      autorizada: Boolean(auth?.[provider]?.autorizada),
      atualizadaEm: auth?.[provider]?.atualizadaEm || null,
      defaultModel: info.defaultModel,
      models: info.models.map((id) => ({ id, name: id })),
    };
  }
  return result;
}

module.exports = {
  status,
  iniciar,
  reiniciar,
  iniciarAutorizacao,
  continuarAutorizacao,
  testar,
  providerSessions,
  WEB_PROVIDERS,
  // Metadados expostos para teste; nunca incluem cookie/sessionKey.
  paths: { TOOL_DIR, AUTH_FILE, CONFIG_FILE, LOG_FILE },
};
