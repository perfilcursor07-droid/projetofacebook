const AiMatters = require('../models/AiMatters');
const Publications = require('../models/Publications');
const materiaIaService = require('./materiaIaService');
const { resolveArtworkPath } = require('./matterArtworkService');
const { formatFacebookCaption } = require('./editorialGuidelinesFb');

function buildMessage(title, body, hashtags) {
  return formatFacebookCaption({
    titulo: title,
    materia: body,
    hashtags,
    incluirTitulo: false,
  });
}

async function publishEditorialPhoto({ userId, matterId, facebookPageId, title, body }) {
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
  const message = buildMessage(finalTitle, finalBody, hashtags);
  if (!message) {
    const err = new Error('Matéria vazia');
    err.status = 400;
    throw err;
  }

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
  });

  try {
    const publishDispatch = require('./publishDispatch');
    const result = await publishDispatch.publishContent({
      userId,
      page,
      tipo: 'foto',
      filePath,
      texto: message,
    });
    const postId = result.post_id || result.id;
    const fbPostUrl = result.fb_post_url || publishDispatch.buildFbPostUrl(page, postId);
    await Publications.update(publicationId, {
      status: 'publicado',
      fb_post_id: postId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    });
    await AiMatters.update(matter.id, {
      status: 'publicado',
      published_at: new Date(),
      error_message: null,
    });
    return { matterId: matter.id, publicationId, queued: false, postId, fbPostUrl };
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
