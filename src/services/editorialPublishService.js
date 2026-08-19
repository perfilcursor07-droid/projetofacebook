const AiMatters = require('../models/AiMatters');
const Publications = require('../models/Publications');
const materiaIaService = require('./materiaIaService');
const { resolveArtworkPath } = require('./matterArtworkService');
const { formatFacebookCaption } = require('./editorialGuidelinesFb');

function buildMessage(title, body, hashtags, fonteCredito) {
  return formatFacebookCaption({
    titulo: title,
    materia: body,
    hashtags,
    fonteCredito,
    incluirTitulo: false,
  });
}

async function publishEditorialPhoto({
  userId,
  matterId,
  facebookPageId,
  title,
  body,
  // null = sem escolha na requisicao; usa o que estiver salvo na materia.
  publicarFacebook = null,
  publicarInstagram = null,
}) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const page = await materiaIaService.resolvePage(userId, facebookPageId || matter.facebook_page_id);
  if (!page) {
    const err = new Error('Conecte/selecione uma página do Facebook');
    err.status = 400;
    throw err;
  }

  const filePath = resolveArtworkPath(matter.imagem_path);
  if (!filePath) {
    const err = new Error('Gere a arte com título e logomarca antes de publicar');
    err.status = 422;
    throw err;
  }

  const finalTitle = String(title || matter.titulo || '').trim();
  const finalBody = String(body || matter.materia || '').trim();
  let hashtags = [];
  try {
    const raw = matter.hashtags;
    if (Array.isArray(raw)) hashtags = raw;
    else if (typeof raw === 'string' && raw.trim()) hashtags = JSON.parse(raw);
  } catch {
    hashtags = [];
  }
  const message = buildMessage(finalTitle, finalBody, hashtags, matter.fonte_credito);
  if (!message) {
    const err = new Error('Matéria vazia');
    err.status = 400;
    throw err;
  }

  const pedidoFacebook =
    publicarFacebook != null
      ? !(publicarFacebook === false || publicarFacebook === 'false' || publicarFacebook === '0')
      : true;
  const pedidoInstagram =
    publicarInstagram != null ? Boolean(publicarInstagram) : Boolean(matter.publicar_instagram);
  if (!pedidoFacebook && !pedidoInstagram) {
    const err = new Error('Selecione Facebook, Instagram ou os dois para publicar.');
    err.status = 400;
    throw err;
  }
  // Quem filtra pelo instagram_ativo da Pagina e o publishDispatch, que tambem
  // devolve o motivo quando o post sai so no Facebook.
  console.log('[publicar] instagram', {
    matterId: matter.id,
    pageId: page.id,
    page: page.page_name,
    pedido: pedidoInstagram,
    origem: publicarInstagram != null ? 'requisicao' : 'materia',
    paginaAtiva: Boolean(page.instagram_ativo),
  });

  const [publicationId] = await Publications.create({
    video_clip_id: null,
    imagem_id: null,
    facebook_page_id: page.id,
    tipo: 'foto',
    status: 'pendente',
    texto: message,
  });

  await AiMatters.update(matter.id, {
    facebook_page_id: page.id,
    tipo_publicacao: 'foto',
    publication_id: publicationId,
    status: 'pronto',
    error_message: null,
    titulo: finalTitle,
    materia: finalBody,
    publicar_instagram: pedidoInstagram,
  });

  try {
    const publishDispatch = require('./publishDispatch');
    const result = await publishDispatch.publishContent({
      userId,
      page,
      tipo: 'foto',
      filePath,
      texto: message,
      publicarFacebook: pedidoFacebook,
      publicarInstagram: pedidoInstagram,
    });
    const postId = result.post_id || result.id;
    const fbPostUrl = pedidoFacebook
      ? result.fb_post_url || publishDispatch.buildFbPostUrl(page, postId)
      : null;
    const pubPatch = {
      status: 'publicado',
      fb_post_id: postId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    };
    if (result.fb_native_post_id) pubPatch.fb_native_post_id = String(result.fb_native_post_id);
    if (result.instagram_post_id) pubPatch.ig_post_id = String(result.instagram_post_id);
    if (result.instagram_post_url) pubPatch.ig_post_url = String(result.instagram_post_url);
    // Instagram recusado nao derruba o post do Facebook: fica como aviso.
    if (result.instagram_erro) {
      pubPatch.erro_mensagem = String(result.instagram_erro).slice(0, 500);
    }
    await Publications.update(publicationId, pubPatch);
    await AiMatters.update(matter.id, {
      status: 'publicado',
      published_at: new Date(),
      error_message: null,
    });
    return {
      matterId: matter.id,
      publicationId,
      queued: false,
      postId,
      fbPostUrl,
      facebookPublicado: pedidoFacebook,
      instagramPedido: pedidoInstagram,
      instagramPublicado: Boolean(result.instagram_publicado),
      instagramPostUrl: result.instagram_post_url || null,
      instagramErro: result.instagram_erro || null,
    };
  } catch (err) {
    const publishDispatch = require('./publishDispatch');
    const messageError = publishDispatch.publishErrorMessage(err);
    await Publications.update(publicationId, {
      status: 'erro',
      erro_mensagem: String(messageError).slice(0, 500),
    });
    await Publications.increment(publicationId);
    await AiMatters.update(matter.id, {
      status: 'erro',
      error_message: String(messageError).slice(0, 500),
    });
    const out = new Error(messageError);
    out.status = err.status || err.response?.status || 502;
    throw out;
  }
}

module.exports = { publishEditorialPhoto };
