const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const gatewayClient = require('./tokenFreeGatewayService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TOOL_DIR = path.resolve(
  process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || path.join(PROJECT_ROOT, '.tools/token-free-gateway')
);
const ENTRY_FILE = path.join(TOOL_DIR, 'index.ts');

function localizarNoPath(nome) {
  const extensoes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const pasta of String(process.env.PATH || '').split(path.delimiter)) {
    if (!pasta) continue;
    for (const extensao of extensoes) {
      const candidato = path.join(pasta, `${nome}${extensao}`);
      if (fs.existsSync(candidato)) return candidato;
    }
  }
  return null;
}

function localizarBun() {
  const configurado = String(process.env.BUN_PATH || '').trim();
  if (configurado) return configurado;

  const candidatos = process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
        path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
      ]
    : [path.join(os.homedir(), '.bun', 'bin', 'bun')];
  return (
    candidatos.find((candidato) => candidato && fs.existsSync(candidato)) ||
    localizarNoPath('bun') ||
    'bun'
  );
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
const MAX_AUTH_IMPORT_CHARS = 512_000;
const MAX_COOKIE_CHARS = 256_000;

const CHROME_CANDIDATES = process.platform === 'win32'
  ? [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  : [
      '/opt/google/chrome/google-chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

let authJob = {
  status: 'idle',
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
  const profile = store?.profiles?.['claude-web'];
  return {
    autorizada: Boolean(profile?.credentials?.sessionKey || profile?.credentials?.cookie),
    atualizadaEm: isoDate(profile?.updatedAt),
  };
}

async function configMetadata() {
  const config = await lerJsonSeguro(CONFIG_FILE, {});
  const chaveGateway = String(
    process.env.TOKEN_FREE_GATEWAY_API_KEY || process.env.TFG_API_KEY || config.apiKey || ''
  ).trim();
  return {
    porta: Number(config.port) || 3456,
    cdpUrl: String(config.cdpUrl || 'http://127.0.0.1:9222'),
    apiKeyProtegida: Boolean(chaveGateway),
    timeoutSegundos: Number(config.requestTimeoutSec) || 300,
  };
}

function ambienteGateway() {
  // O cliente prioriza TOKEN_FREE_GATEWAY_API_KEY. Repassa esse mesmo valor
  // como TFG_API_KEY ao processo filho para impedir que /health funcione
  // (rota publica), mas /v1/models e /chat retornem 401 por chaves diferentes.
  const apiKey = String(
    process.env.TOKEN_FREE_GATEWAY_API_KEY || process.env.TFG_API_KEY || ''
  ).trim();
  return apiKey ? { TFG_API_KEY: apiKey } : {};
}

function authJobPublico() {
  return {
    status: authJob.status,
    message: authJob.message,
    startedAt: authJob.startedAt,
    finishedAt: authJob.finishedAt,
  };
}

function estaDentroDaPasta(pasta, arquivo) {
  const relativo = path.relative(path.resolve(pasta), path.resolve(arquivo));
  return relativo === '' || (!relativo.startsWith('..') && !path.isAbsolute(relativo));
}

function loginVisualDisponivel() {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function diagnosticoInstalacao() {
  const cliDisponivel = fs.existsSync(ENTRY_FILE);
  const bunDisponivel = path.isAbsolute(BUN_PATH) ? fs.existsSync(BUN_PATH) : BUN_PATH !== 'bun';
  const chromeInstalado = CHROME_CANDIDATES.some((candidate) => candidate && fs.existsSync(candidate));
  let pendencia = null;
  if (!cliDisponivel) pendencia = 'Execute npm run gateway:setup para instalar o token-free-gateway.';
  else if (!bunDisponivel) pendencia = 'Bun não encontrado. Instale-o para o usuário que executa o Node.';
  else if (!chromeInstalado) pendencia = 'Google Chrome ou Chromium não encontrado no servidor.';
  return { cliDisponivel, bunDisponivel, chromeInstalado, pendencia };
}

async function status() {
  const [auth, config] = await Promise.all([authMetadata(), configMetadata()]);
  const instalacao = diagnosticoInstalacao();
  let health = null;
  let healthError = null;
  let modelos = [];
  let modelosError = null;

  try {
    health = await gatewayClient.verificarSaude({ timeout: 3_500 });
    try {
      modelos = await gatewayClient.listarModelos({ timeout: 3_500 });
    } catch (err) {
      modelos = [];
      modelosError = err.message;
    }
  } catch (err) {
    healthError = err.message;
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
      cliDisponivel: instalacao.cliDisponivel,
      bunDisponivel: instalacao.bunDisponivel,
      chromeInstalado: instalacao.chromeInstalado,
      pendencia: instalacao.pendencia,
      plataforma: process.platform,
    },
    chrome: {
      conectado: health?.browser === 'connected',
      cdpUrl: config.cdpUrl,
      loginVisualDisponivel: loginVisualDisponivel(),
      modoHeadless: process.platform === 'linux' && !loginVisualDisponivel(),
    },
    claude: {
      autorizada: auth.autorizada,
      atualizadaEm: auth.atualizadaEm,
      valida: sessao?.valid === true ? true : sessao?.valid === false ? false : null,
      motivo: sessao?.reason || null,
      modelo: modeloConfigurado,
      modeloDisponivel,
      modelosListados: modelos.length,
      modeloErro: modelosError,
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
      if (err.code === 'ENOENT') {
        err.message = `Executável não encontrado: ${executavel}. Execute npm run gateway:setup.`;
        err.status = 503;
      }
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
    'Token-free-gateway não instalado neste servidor. Execute npm run gateway:setup.'
  );
  err.status = 503;
  throw err;
}

async function comandoGateway(command) {
  assertCli();
  return executar(BUN_PATH, [ENTRY_FILE, command], {
    cwd: TOOL_DIR,
    env: ambienteGateway(),
  });
}

async function iniciar() {
  await comandoGateway('start');
  return { ok: true, message: 'Gateway iniciado.' };
}

async function reiniciar() {
  await comandoGateway('restart');
  return { ok: true, message: 'Gateway reiniciado.' };
}

async function removerCredencialClaude() {
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  if (!store.profiles['claude-web']) return false;
  delete store.profiles['claude-web'];
  await fsp.mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await salvarAuthStore(store);
  return true;
}

async function salvarAuthStore(store) {
  await fsp.mkdir(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  const tempPath = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fsp.rename(tempPath, AUTH_FILE);
  await fsp.chmod(AUTH_FILE, 0o600).catch(() => {});
}

function extrairPerfilClaude(payload) {
  let conteudo = payload;
  if (typeof conteudo === 'string') {
    if (conteudo.length > MAX_AUTH_IMPORT_CHARS) {
      const err = new Error('O arquivo de sessão é maior que o limite permitido.');
      err.status = 413;
      throw err;
    }
    try {
      conteudo = JSON.parse(conteudo);
    } catch {
      const err = new Error('O arquivo selecionado não contém JSON válido.');
      err.status = 400;
      throw err;
    }
  }

  if (!conteudo || typeof conteudo !== 'object') {
    const err = new Error('Arquivo de sessão inválido.');
    err.status = 400;
    throw err;
  }
  if (JSON.stringify(conteudo).length > MAX_AUTH_IMPORT_CHARS) {
    const err = new Error('O arquivo de sessão é maior que o limite permitido.');
    err.status = 413;
    throw err;
  }

  const perfil = conteudo?.profiles?.['claude-web'] || conteudo?.profile || conteudo;
  const credentials = perfil?.credentials || perfil;
  const sessionKey = String(credentials?.sessionKey || '').trim();
  if (!/^sk-ant-sid0[12]-[A-Za-z0-9_-]+$/.test(sessionKey)) {
    const err = new Error('A sessão não contém uma sessionKey válida do Claude.');
    err.status = 400;
    throw err;
  }

  let cookie = String(credentials?.cookie || '').trim();
  if (cookie.length > MAX_COOKIE_CHARS) {
    const err = new Error('Os cookies da sessão excedem o limite permitido.');
    err.status = 413;
    throw err;
  }
  if (!cookie) cookie = `sessionKey=${sessionKey}`;

  return {
    providerId: 'claude-web',
    credentials: {
      sessionKey,
      cookie,
      userAgent: String(credentials?.userAgent || '').slice(0, 1_000),
      ...(credentials?.organizationId
        ? { organizationId: String(credentials.organizationId).slice(0, 200) }
        : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

async function importarSessao(payload) {
  const perfil = extrairPerfilClaude(payload);
  const store = await lerJsonSeguro(AUTH_FILE, { profiles: {} });
  if (!store.profiles || typeof store.profiles !== 'object') store.profiles = {};
  store.profiles['claude-web'] = perfil;
  await salvarAuthStore(store);

  if (!diagnosticoInstalacao().cliDisponivel) {
    return {
      ok: true,
      gatewayReiniciado: false,
      message: 'Sessão importada. Instale o gateway e depois clique em Iniciar gateway.',
    };
  }

  try {
    await reiniciar();
    return {
      ok: true,
      gatewayReiniciado: true,
      message: 'Sessão importada e gateway reiniciado.',
    };
  } catch (err) {
    return {
      ok: true,
      gatewayReiniciado: false,
      message: `Sessão importada, mas o gateway não iniciou: ${String(err.message).slice(0, 300)}`,
    };
  }
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
  await removerCredencialClaude();
}

function iniciarAutorizacao({ trocarConta = false } = {}) {
  assertCli();
  if (!loginVisualDisponivel() && process.env.TOKEN_FREE_GATEWAY_ALLOW_HEADLESS_AUTH !== 'true') {
    const err = new Error(
      'Este servidor não possui área de trabalho. Autorize no seu computador e importe o arquivo de sessão nesta página.'
    );
    err.status = 409;
    throw err;
  }
  if (authJob.status === 'running' || authJob.status === 'waiting_login') {
    const err = new Error('Já existe uma autorização do Claude em andamento.');
    err.status = 409;
    throw err;
  }

  authJob = {
    status: 'running',
    message: trocarConta
      ? 'Preparando o Chrome para entrar em outra conta…'
      : 'Abrindo o Chrome do servidor para autorizar o Claude…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  // O endpoint responde imediatamente. A tela acompanha este trabalho por polling.
  void (async () => {
    try {
      if (trocarConta) await limparSessaoClaudeDoChrome();

      // Faz o webauth abrir uma janela nova e aguardar a confirmação manual.
      // Sem isso, um Chrome já aberto tentaria capturar a sessão imediatamente.
      await executar(BUN_PATH, [ENTRY_FILE, 'chrome', 'stop'], {
        cwd: TOOL_DIR,
        timeout: COMMAND_TIMEOUT_MS,
      });

      const child = spawn(BUN_PATH, [ENTRY_FILE, 'webauth'], {
        cwd: TOOL_DIR,
        env: process.env,
        windowsHide: true,
        shell: false,
      });
      activeAuthChild = child;
      let buffer = '';
      let detectouPromptLogin = false;
      let enviouClaude = false;
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
        if (!detectouPromptLogin && /Please log in[\s\S]*press Enter/i.test(buffer)) {
          detectouPromptLogin = true;
          authJob = {
            ...authJob,
            status: 'waiting_login',
            message: 'Chrome aberto. Entre no Claude e depois clique em “Já entrei, concluir”.',
          };
        }
        if (!enviouClaude && /Enter selection:/i.test(buffer)) {
          enviouClaude = true;
          child.stdin?.write('1\n');
          authJob = {
            ...authJob,
            status: 'running',
            message: 'Capturando a nova sessão do Claude…',
          };
        }
        if (/Claude Web authorization succeeded/i.test(buffer)) concluida = true;
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
        if (!['running', 'waiting_login'].includes(authJob.status)) return;
        if (!concluida) {
          authJob = {
            ...authJob,
            status: 'error',
            message: 'O Claude não confirmou a nova sessão. Abra o Chrome e tente novamente.',
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
            message: 'Claude autorizado e gateway reiniciado com sucesso.',
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
    const err = new Error('Não existe um login do Claude aguardando confirmação.');
    err.status = 409;
    throw err;
  }

  authJob = {
    ...authJob,
    status: 'running',
    message: 'Confirmando o login e capturando a sessão do Claude…',
  };
  activeAuthChild.stdin.write('\n');
  return authJobPublico();
}

async function testar() {
  const inicio = Date.now();
  try {
    const { data } = await axios.post(
      `${gatewayClient.BASE_URL}/chat/completions`,
      {
        model: gatewayClient.MODELO,
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
      const err = new Error('O Claude respondeu sem conteúdo.');
      err.status = 502;
      throw err;
    }
    return {
      ok: true,
      message: `Claude respondeu em ${((Date.now() - inicio) / 1000).toFixed(1)}s.`,
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
    const falha = new Error(`Teste do Claude falhou: ${remoto.slice(0, 500)}`);
    falha.status = Number(err?.response?.status) || 502;
    throw falha;
  }
}

module.exports = {
  status,
  iniciar,
  reiniciar,
  iniciarAutorizacao,
  continuarAutorizacao,
  importarSessao,
  testar,
  // Metadados expostos para teste; nunca incluem cookie/sessionKey.
  paths: { TOOL_DIR, AUTH_FILE, CONFIG_FILE, LOG_FILE },
};
