const ApiTokens = require('../models/ApiTokens');

// Rate limit simples em memória, por token: janela de 60s.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const buckets = new Map(); // tokenId -> { windowStart, count }

function isRateLimited(tokenId) {
  const now = Date.now();
  const bucket = buckets.get(tokenId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(tokenId, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

// Limpeza periódica para não acumular tokens antigos.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS * 5) buckets.delete(key);
  }
}, WINDOW_MS).unref();

/**
 * Autentica rotas da extensão via Authorization: Bearer <token>.
 * Define req.apiToken (row) e req.apiUserId. Não usa sessão.
 */
async function requireApiToken(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) {
      return res.status(401).json({ error: 'Token ausente. Use Authorization: Bearer <token>' });
    }

    const row = await ApiTokens.findValidByToken(token);
    if (!row) {
      return res.status(401).json({ error: 'Token inválido ou revogado' });
    }

    if (isRateLimited(row.id)) {
      return res.status(429).json({ error: 'Muitas requisições. Aguarde um instante.' });
    }

    req.apiToken = row;
    req.apiUserId = Number(row.user_id);

    // Não bloqueia a resposta por causa do touch.
    ApiTokens.touch(row.id).catch(() => {});
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireApiToken };
