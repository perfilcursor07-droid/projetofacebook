const facebookPageScrape = require('./facebookPageScrape');
const apifyFacebookService = require('./apifyFacebookService');

function validarPaginaFacebook(valor) {
  const raw = String(valor || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error('Cole uma URL válida de página do Facebook.');
    err.status = 400;
    throw err;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!['facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com'].includes(host)) {
    const err = new Error('O link precisa ser de uma página ou perfil público do Facebook.');
    err.status = 400;
    throw err;
  }
  url.protocol = 'https:';
  url.hash = '';
  return url.toString();
}

/** Diferencia uma página/perfil de um link de publicação. */
function ehUrlPaginaFacebook(valor) {
  let url;
  try {
    url = new URL(String(valor || '').trim());
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!['facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com'].includes(host)) return false;
  if (facebookPageScrape.ehUrlDePostValida(url.toString())) return false;

  if (/^\/profile\.php$/i.test(url.pathname)) return /^\d+$/.test(url.searchParams.get('id') || '');

  const partes = url.pathname.split('/').filter(Boolean);
  if (partes.length !== 1) return false;
  const reservados = new Set([
    'login', 'watch', 'groups', 'marketplace', 'gaming', 'events', 'friends',
    'notifications', 'messages', 'settings', 'help', 'share', 'photo', 'photos',
    'videos', 'reel', 'reels', 'posts',
  ]);
  return !reservados.has(String(partes[0] || '').toLowerCase());
}

function chavePost(item) {
  return String(item?.url || item?.externalId || '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function dataDoPost(valor) {
  if (!valor) return { data: null, dataTimestamp: null };
  const date = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(date.getTime())) return { data: null, dataTimestamp: null };
  return { data: date.toISOString(), dataTimestamp: date.getTime() };
}

function normalizarPost(item, pagina, origem) {
  const texto = String(item?.texto || item?.resumo || '').replace(/\r\n/g, '\n').trim();
  const url = String(item?.url || '').trim();
  const imagem = String(item?.thumbnail || item?.imagem || '').trim() || null;
  if (!url || (!texto && !imagem)) return null;
  const titulo = String(item?.titulo || texto.split(/\n/).find(Boolean) || 'Post do Facebook')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const dataInfo = dataDoPost(item?.publicadoEm || item?.data || item?.dataTimestamp);
  return {
    titulo,
    url,
    resumo: texto.slice(0, 5000),
    imagem,
    mediaType: item?.mediaType || (/\/(?:reel|videos)\//i.test(url) ? 'video' : 'image'),
    autor: String(item?.autor || '').trim() || null,
    likes: Number(item?.likes) || 0,
    comments: Number(item?.comments) || 0,
    shares: Number(item?.shares) || 0,
    veiculo: 'Facebook',
    pagina,
    origem,
    ...dataInfo,
  };
}

async function listarPostsDaPagina(pageUrl, { limit = 20 } = {}) {
  const paginaUrl = validarPaginaFacebook(pageUrl);
  const limite = Math.min(40, Math.max(3, Number(limit) || 40));
  const handle = apifyFacebookService.handleDaPaginaUrl(paginaUrl) || 'Página do Facebook';
  const avisos = [];
  const reunidos = [];

  // Principal: feed público paginado do Page Plugin oficial da Meta. Não usa
  // Apify, ScrapeCreators nem Serper; a sessão fica apenas como fallback para
  // perfis que o plugin não aceita.
  try {
    const posts = await facebookPageScrape.listarPostsPerfil(paginaUrl, limite);
    for (const post of posts) reunidos.push(normalizarPost(post, handle, 'feed-publico-facebook'));
  } catch (err) {
    console.warn('[materia-facebook] feed público:', err.message);
    avisos.push(`Facebook: ${err.message}`);
  }

  // Complemento gratuito por índice web. Não usa Serper/ScrapeCreators e
  // ajuda a preencher a lista quando o HTML inicial do Facebook traz poucos.
  if (reunidos.filter(Boolean).length < limite) {
    try {
      const postsWeb = await apifyFacebookService.buscarPostsPaginaViaWeb(paginaUrl, {
        limit: limite,
        serper: false,
      });
      for (const post of postsWeb) reunidos.push(normalizarPost(post, handle, 'indice-web'));
    } catch (err) {
      console.warn('[materia-facebook] índice web:', err.message);
      avisos.push(`Índice web: ${err.message}`);
    }
  }

  const vistos = new Set();
  let posts = reunidos
    .filter(Boolean)
    .filter((post) => {
      const chave = chavePost(post);
      if (!chave || vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    })
    .slice(0, limite);

  if (!posts.length) {
    const err = new Error(
      'Não consegui listar posts dessa página. Confira se ela é pública e teste com scripts/test-fb-page.js.'
    );
    err.status = 422;
    err.avisos = avisos;
    throw err;
  }

  try {
    posts = await require('./deepseekService').traduzirPostsParaPortugues(posts);
  } catch (err) {
    console.warn('[materia-facebook] tradução:', err.message);
    avisos.push(`Tradução: ${err.message}`);
  }

  return {
    paginaUrl,
    pagina: handle,
    posts,
    total: posts.length,
    fonte: posts[0]?.origem || 'facebook',
    avisos,
  };
}

module.exports = {
  validarPaginaFacebook,
  ehUrlPaginaFacebook,
  normalizarPost,
  listarPostsDaPagina,
};
