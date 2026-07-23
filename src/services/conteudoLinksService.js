/**
 * Links salvos para reutilizar em /conteudo (Radar + A partir do link).
 */
const ConteudoLinks = require('../models/ConteudoLinks');

function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    const err = new Error('Informe uma URL válida (http/https)');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    const err = new Error('URL inválida');
    err.status = 400;
    throw err;
  }
}

function detectarTipo(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.toLowerCase();
    const isFb =
      host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch' || host === 'm.facebook.com';

    if (isFb) {
      if (/\/reel\//.test(path) || /\/reels\//.test(path) || /\/videos\//.test(path)) return 'reel';
      if (
        /\/posts\//.test(path) ||
        /\/permalink\.php/.test(path) ||
        /\/photo\.php/.test(path) ||
        /\/photo\//.test(path) ||
        u.searchParams.has('story_fbid') ||
        u.searchParams.has('fbid')
      ) {
        return 'post';
      }
      return 'pagina';
    }
    if (host.includes('instagram.com')) {
      if (/\/reel\//.test(path) || /\/reels\//.test(path)) return 'reel';
      if (/\/p\//.test(path)) return 'post';
      return 'pagina';
    }
    return 'noticia';
  } catch {
    return 'outro';
  }
}

function nomePadrao(url, tipo) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (tipo === 'pagina' && parts[0] && !['posts', 'photo', 'watch', 'reel', 'reels', 'videos', 'share'].includes(parts[0])) {
      return decodeURIComponent(parts[0]).replace(/\+/g, ' ').slice(0, 80);
    }
    if (parts[0]) return decodeURIComponent(parts[0]).slice(0, 80);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'Link salvo';
  }
}

async function listar(userId) {
  return ConteudoLinks.findByUser(userId);
}

async function salvar(userId, { url, nome, notas, tipo } = {}) {
  const normalized = normalizeUrl(url);
  const tipoFinal = ['pagina', 'post', 'reel', 'noticia', 'outro'].includes(tipo)
    ? tipo
    : detectarTipo(normalized);
  const nomeFinal = String(nome || nomePadrao(normalized, tipoFinal))
    .trim()
    .slice(0, 200) || 'Link salvo';

  const existente = await ConteudoLinks.findByUserAndUrl(userId, normalized);
  if (existente) {
    await ConteudoLinks.update(existente.id, {
      nome: nomeFinal,
      tipo: tipoFinal,
      notas: notas != null ? String(notas).slice(0, 500) : existente.notas,
    });
    return ConteudoLinks.findById(existente.id);
  }

  const [id] = await ConteudoLinks.create({
    user_id: userId,
    nome: nomeFinal,
    url: normalized,
    tipo: tipoFinal,
    notas: notas != null ? String(notas).slice(0, 500) : null,
  });
  return ConteudoLinks.findById(id);
}

async function remover(userId, id) {
  const row = await ConteudoLinks.findById(id);
  if (!row || Number(row.user_id) !== Number(userId)) {
    const err = new Error('Link não encontrado');
    err.status = 404;
    throw err;
  }
  await ConteudoLinks.deleteByUser(id, userId);
  return { ok: true };
}

module.exports = {
  listar,
  salvar,
  remover,
  normalizeUrl,
  detectarTipo,
};
