require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const gateway = require('../src/services/tokenFreeGatewayService');

const AUTH_FILE = process.env.TFG_STORE_PATH || path.join(
  os.homedir(),
  '.token-free-gateway',
  'auth-profiles.json'
);

function portaAberta(porta, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: porta });
    let terminou = false;
    const finalizar = (online) => {
      if (terminou) return;
      terminou = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finalizar(true));
    socket.once('timeout', () => finalizar(false));
    socket.once('error', () => finalizar(false));
  });
}

function lerPerfilSemSegredos() {
  try {
    const store = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const profile = store?.profiles?.['claude-web'];
    const credentials = profile?.credentials || {};
    const cookieNames = String(credentials.cookie || '')
      .split(';')
      .map((item) => item.trim().split('=')[0])
      .filter(Boolean);
    return {
      arquivoExiste: true,
      perfilClaude: Boolean(profile),
      sessionKey: Boolean(credentials.sessionKey),
      userAgent: Boolean(credentials.userAgent),
      cookies: cookieNames,
      atualizadoEm: profile?.updatedAt || null,
    };
  } catch (err) {
    return {
      arquivoExiste: fs.existsSync(AUTH_FILE),
      perfilClaude: false,
      erro: err.code === 'ENOENT' ? 'arquivo não encontrado' : 'JSON inválido ou sem permissão',
    };
  }
}

async function testarCdp() {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/version', {
      signal: AbortSignal.timeout(2500),
    });
    const data = await response.json();
    return {
      online: response.ok,
      browser: data.Browser || null,
      headless: /headless/i.test(String(data['User-Agent'] || '')),
    };
  } catch (err) {
    return { online: false, erro: err.message };
  }
}

async function main() {
  const [cdp, desktop] = await Promise.all([testarCdp(), portaAberta(6080)]);
  const auth = lerPerfilSemSegredos();
  let health = null;
  let healthError = null;
  let models = [];
  let modelsError = null;

  try {
    health = await gateway.verificarSaude({ timeout: 5000 });
  } catch (err) {
    healthError = err.message;
  }
  try {
    models = await gateway.listarModelos({ timeout: 5000 });
  } catch (err) {
    modelsError = err.message;
  }

  const session = health?.sessions?.['claude-web'];
  const report = {
    usuario: os.userInfo().username,
    authFile: AUTH_FILE,
    auth,
    display: process.env.DISPLAY || null,
    desktopNoVnc: desktop,
    chromeCdp: cdp,
    gateway: {
      online: Boolean(health),
      status: health?.status || null,
      browser: health?.browser || null,
      erro: healthError,
    },
    claude: {
      sessaoValida: session?.valid ?? null,
      motivo: session?.reason || null,
      modelo: gateway.MODELO,
      modeloListado: models.some((model) => model?.id === gateway.MODELO),
      erroModelos: modelsError,
    },
  };

  if (process.argv.includes('--chat')) {
    try {
      const resposta = await gateway.chatCompletion(
        [{ role: 'user', content: 'Responda somente com OK.' }],
        { json: false, timeout: 45000, tarefa: 'conversa' }
      );
      report.chat = { ok: true, resposta: String(resposta).slice(0, 80) };
    } catch (err) {
      report.chat = { ok: false, erro: err.message };
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (!health || session?.valid !== true || !report.claude.modeloListado) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ erro: err.message }, null, 2));
  process.exitCode = 1;
});
