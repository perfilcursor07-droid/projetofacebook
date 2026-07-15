const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { fetchLinkMetadata, humanizeYtDlpError } = require('../services/importService');

const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" — vídeo público estável

const AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PSID', '__Secure-1PSID', 'SID', 'LOGIN_INFO'];

function getTargetPath() {
  const configured = String(env.ytDlp.cookiesFile || '').trim();
  if (!configured) return null;
  return path.resolve(configured);
}

/** Mantém só o cabeçalho Netscape + linhas de cookie do youtube.com. */
function filterYoutubeCookies(rawText) {
  const lines = String(rawText).replace(/\r\n/g, '\n').split('\n');
  const kept = ['# Netscape HTTP Cookie File', '# Gerado pelo ViralizeAI — apenas cookies do YouTube', ''];
  let cookieCount = 0;
  let authCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0].toLowerCase();
    if (!domain.includes('youtube.com')) continue;
    kept.push(line);
    cookieCount += 1;
    const name = parts[5];
    if (AUTH_COOKIE_NAMES.includes(name)) authCount += 1;
  }

  return { content: kept.join('\n') + '\n', cookieCount, authCount };
}

function fileStatus() {
  const target = getTargetPath();
  if (!target) {
    return {
      configured: false,
      message:
        'YTDLP_COOKIES_FILE não está configurado no ambiente. Em desenvolvimento use YTDLP_COOKIES_FROM_BROWSER; em produção configure o caminho do arquivo.',
    };
  }
  const status = { configured: true, path: target, exists: false };
  try {
    const stat = fs.statSync(target);
    status.exists = true;
    status.sizeBytes = stat.size;
    status.updatedAt = stat.mtime.toISOString();
    const { cookieCount, authCount } = filterYoutubeCookies(fs.readFileSync(target, 'utf8'));
    status.cookieCount = cookieCount;
    status.hasAuthCookies = authCount > 0;
  } catch {
    // arquivo ainda não existe — status.exists = false
  }
  return status;
}

async function getStatus(_req, res) {
  res.json(fileStatus());
}

async function upload(req, res, next) {
  try {
    const target = getTargetPath();
    if (!target) {
      return res.status(503).json({
        error: 'YTDLP_COOKIES_FILE não configurado no servidor — não há onde salvar o arquivo.',
      });
    }

    let rawText = '';
    if (req.file && req.file.buffer) {
      rawText = req.file.buffer.toString('utf8');
    } else if (typeof req.body?.conteudo === 'string') {
      rawText = req.body.conteudo;
    }
    if (!rawText.trim()) {
      return res.status(400).json({ error: 'Envie o arquivo cookies.txt ou cole o conteúdo dele.' });
    }

    const { content, cookieCount, authCount } = filterYoutubeCookies(rawText);
    if (cookieCount === 0) {
      return res.status(400).json({
        error:
          'Nenhum cookie do youtube.com encontrado no arquivo. Exporte os cookies com a aba do YouTube aberta (formato Netscape).',
      });
    }
    if (authCount === 0) {
      return res.status(400).json({
        error:
          'Os cookies não têm sessão logada (faltam SAPISID/__Secure-3PSID). Faça login no YouTube antes de exportar — de preferência em janela anônima.',
      });
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });

    res.json({
      ok: true,
      cookieCount,
      message: `${cookieCount} cookie(s) do YouTube salvos. Rode o teste para confirmar.`,
    });
  } catch (err) {
    next(err);
  }
}

async function test(_req, res) {
  try {
    const info = await fetchLinkMetadata(TEST_VIDEO_URL);
    res.json({ ok: true, titulo: info.titulo, message: 'Cookies válidos — YouTube respondeu normalmente.' });
  } catch (err) {
    res.status(502).json({ ok: false, error: humanizeYtDlpError(err) });
  }
}

module.exports = { getStatus, upload, test };
