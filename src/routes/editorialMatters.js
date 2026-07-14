const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const AiMatters = require('../models/AiMatters');
const materiaIaService = require('../services/materiaIaService');
const { composeMatterArtwork } = require('../services/matterArtworkService');
const { publishEditorialPhoto } = require('../services/editorialPublishService');

const router = express.Router();
router.use(requireAuth);

function pageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id;
  return raw != null && raw !== '' ? Number(raw) : null;
}

function publicationType(body = {}) {
  return (body.tipoPublicacao ?? body.tipo_publicacao) === 'foto' ? 'foto' : 'texto';
}

async function addArtwork(userId, result) {
  const article = result.artigo || result.preview || {};
  const matter = result.matter;
  const warnings = Array.isArray(result.avisos) ? [...result.avisos] : [];
  const sourceUrl = article.imagemUrl || matter?.imagem_fonte_url || null;
  if (!matter?.id || !sourceUrl) return { ...result, artigo: article, preview: article, avisos: warnings };

  const sourceMeta = article.imagemOrigem || null;
  try {
    const artwork = await composeMatterArtwork({
      userId,
      matterId: matter.id,
      sourceUrl,
      title: article.titulo || matter.titulo,
      force: true,
    });
    article.imagemUrl = artwork.publicUrl;
    article.imagemOrigem = {
      ...(sourceMeta || {}),
      tipo: 'arte',
      rotulo: `Arte final 4:5 com título${artwork.hasLogo ? ' e logomarca' : ''} · ${sourceMeta?.rotulo || 'foto editorial'}`,
      hasLogo: artwork.hasLogo,
    };
    if (!artwork.hasLogo) warnings.push('Arte criada sem logomarca. Envie o arquivo em Minha marca.');
    return { ...result, matter: artwork.matter, artigo: article, preview: article, avisos: warnings };
  } catch (err) {
    await AiMatters.update(matter.id, {
      imagem_fonte_url: sourceUrl,
      imagem_path: null,
      imagem_url: null,
      error_message: String(err.message).slice(0, 500),
    });
    article.imagemUrl = null;
    warnings.push(`Não foi possível criar a arte com título e logomarca: ${err.message}`);
    return {
      ...result,
      matter: await AiMatters.findById(matter.id),
      artigo: article,
      preview: article,
      avisos: warnings,
    };
  }
}

async function publishGenerated(userId, result, facebookPageId, type) {
  if (type === 'foto') {
    if (!result.matter?.imagem_path) {
      result.avisos = [...(result.avisos || []), 'A publicação não foi enviada porque a arte final não pôde ser criada.'];
      return result;
    }
    const published = await publishEditorialPhoto({
      userId,
      matterId: result.matter.id,
      facebookPageId,
      title: result.artigo.titulo,
      body: result.artigo.materia,
    });
    return {
      ...result,
      publication: published,
      fbPostUrl: published.fbPostUrl,
      matter: await AiMatters.findById(result.matter.id),
    };
  }

  const published = await materiaIaService.publicarMateria(userId, result.matter.id, {
    facebook_page_id: facebookPageId,
    tipo_publicacao: 'texto',
    titulo: result.artigo.titulo,
    materia: result.artigo.materia,
    sync: true,
  });
  return {
    ...result,
    publication: published,
    fbPostUrl: published.fbPostUrl,
    matter: await AiMatters.findById(result.matter.id),
  };
}

router.post('/gerar', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.topico?.titulo) return res.status(400).json({ error: 'Envie um tópico válido' });
    const facebookPageId = pageId(body);
    const type = publicationType(body);
    const wantsPublish = String(body.status || '').toLowerCase() === 'publicado';
    if (wantsPublish && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    let result = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico: body.topico,
      facebookPageId,
      tipoPublicacao: type,
      status: 'rascunho',
      investigativa: Boolean(body.investigativa),
    });
    result = await addArtwork(req.session.userId, result);
    if (wantsPublish) result = await publishGenerated(req.session.userId, result, facebookPageId, type);

    return res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/gerar-preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.topico?.titulo) return res.status(400).json({ error: 'Envie um tópico válido' });
    const type = publicationType(body);
    const facebookPageId = pageId(body);
    const generated = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico: body.topico,
      facebookPageId,
      tipoPublicacao: type,
      status: 'rascunho',
      investigativa: Boolean(body.investigativa),
    });
    const result = await addArtwork(req.session.userId, generated);
    return res.json({ ok: true, ...result, preview: result.artigo });
  } catch (err) {
    return next(err);
  }
});

router.post('/matters/:id/publicar', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const matter = await AiMatters.findById(Number(req.params.id));
    if (!matter || Number(matter.user_id) !== Number(userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    const type = publicationType(req.body);
    const facebookPageId = pageId(req.body);

    if (type === 'foto') {
      const title = String(req.body.titulo || matter.titulo || '').trim();
      const sourceUrl = matter.imagem_fonte_url ||
        (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || '')) ? matter.imagem_url : null);
      const artwork = await composeMatterArtwork({
        userId,
        matterId: matter.id,
        sourceUrl,
        title,
        force: title !== String(matter.titulo || '').trim(),
      });
      const published = await publishEditorialPhoto({
        userId,
        matterId: matter.id,
        facebookPageId,
        title,
        body: req.body.materia || matter.materia,
      });
      return res.json({ ok: true, ...published, link: published.fbPostUrl, imagemUrl: artwork.publicUrl });
    }

    const published = await materiaIaService.publicarMateria(userId, matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: 'texto',
      titulo: req.body.titulo,
      materia: req.body.materia,
      sync: Boolean(req.body.sync),
    });
    return res.status(published.queued ? 202 : 200).json({
      ok: true,
      ...published,
      link: published.fbPostUrl || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/gerar-lote', async (req, res, next) => {
  try {
    const topics = Array.isArray(req.body?.topicos) ? req.body.topicos.slice(0, 5) : [];
    const facebookPageId = pageId(req.body);
    const type = publicationType(req.body);
    if (!topics.length) return res.status(400).json({ error: 'Selecione ao menos um tópico' });
    if (!facebookPageId) return res.status(400).json({ error: 'Selecione a página do Facebook' });

    const criados = [];
    const erros = [];
    for (const topic of topics) {
      try {
        let result = await materiaIaService.gerarCompleto({
          userId: req.session.userId,
          topico: topic,
          facebookPageId,
          tipoPublicacao: type,
          status: 'rascunho',
        });
        result = await addArtwork(req.session.userId, result);
        if (type === 'foto' && !result.matter?.imagem_path) {
          erros.push({ titulo: topic.titulo || '—', erro: result.avisos?.at(-1) || 'Arte não gerada' });
          criados.push({ matterId: result.matter?.id, titulo: result.artigo?.titulo, rascunho: true });
          continue;
        }
        result = await publishGenerated(req.session.userId, result, facebookPageId, type);
        criados.push({
          matterId: result.matter.id,
          publicationId: result.publication?.publicationId,
          titulo: result.artigo.titulo,
        });
      } catch (err) {
        erros.push({ titulo: topic?.titulo || '—', erro: err.message });
      }
    }
    return res.json({ ok: true, criados, erros });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
