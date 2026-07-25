/**
 * Radar Instagram por perfil (ScrapeCreators): coleta os últimos posts de perfis
 * gospel conhecidos. É mais estável que a busca por palavra-chave, que às vezes
 * devolve desafio temporário ou reels fora do nicho.
 */
const crypto = require('crypto');
const scrapeCreatorsInstagram = require('./scrapeCreatorsInstagram');

function isConfigured() {
  return scrapeCreatorsInstagram.isConfigured();
}

function slugId(titulo, link) {
  const base = `${titulo || ''}|${link || ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function postParaTopico(item, perfil) {
  if (!item || !item.url) return null;
  const handle = String(perfil?.handle || '').replace(/^@/, '');
  const titulo = String(item.titulo || `Post @${handle}`).slice(0, 120);
  const publicado = item.publicadoEm ? new Date(item.publicadoEm) : null;
  const ts = publicado && !Number.isNaN(publicado.getTime()) ? publicado.getTime() : 0;

  return {
    id: slugId(titulo, item.url),
    titulo,
    resumo: item.resumo || null,
    link: item.url,
    fonte: 'ScrapeCreators · Instagram',
    veiculo: perfil?.nome || (handle ? `@${handle}` : 'Instagram'),
    tipoFonte: 'rede_social',
    redeSocial: true,
    plataforma: 'instagram',
    origemSocial: 'instagram',
    likes: 0,
    comments: 0,
    shares: 0,
    views: 0,
    data: publicado ? publicado.toISOString() : null,
    dataTimestamp: ts,
    recente: true,
    imagemUrl: item.thumbnail || null,
  };
}

/**
 * Coleta posts recentes de vários perfis do Instagram.
 * @param {Array<{nome?: string, handle: string}>} perfis
 * @param {{ postsPorPerfil?: number, maxAgeDays?: number }} [opts]
 */
async function coletarTopicosDePerfis(perfis, opts = {}) {
  const lista = (Array.isArray(perfis) ? perfis : [])
    .map((p) => (typeof p === 'string' ? { handle: p } : p))
    .filter((p) => p && String(p.handle || '').trim());

  const postsPorPerfil = Math.min(12, Math.max(1, Number(opts.postsPorPerfil) || 4));
  const maxAgeDays = Math.max(1, Number(opts.maxAgeDays) || 7);
  const limiteData = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const topicos = [];
  const avisos = [];
  const vistos = new Set();

  for (const perfil of lista) {
    const handle = String(perfil.handle).replace(/^@/, '').trim();
    try {
      const itens = await scrapeCreatorsInstagram.listarPostsPerfil(handle, postsPorPerfil);
      for (const item of itens) {
        const topico = postParaTopico(item, { ...perfil, handle });
        if (!topico) continue;
        if (topico.dataTimestamp && topico.dataTimestamp < limiteData) continue;
        const key = String(topico.link).split(/[?#]/)[0].toLowerCase();
        if (vistos.has(key)) continue;
        vistos.add(key);
        topicos.push(topico);
      }
    } catch (err) {
      avisos.push(`IG @${handle}: ${err.message}`);
    }
  }

  return { topicos, avisos };
}

module.exports = {
  isConfigured,
  coletarTopicosDePerfis,
  postParaTopico,
};
