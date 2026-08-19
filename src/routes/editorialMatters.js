const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { uploadMatterImage } = require('../middleware/uploadMatterImage');
const AiMatters = require('../models/AiMatters');
const materiaIaService = require('../services/materiaIaService');
const {
  composeMatterArtwork,
  applyBrandArtworkToResult,
  storeMatterSourceImage,
  cropMatterSourceImage,
  removeMatterSourceImage,
} = require('../services/matterArtworkService');
const { publishEditorialPhoto } = require('../services/editorialPublishService');

const router = express.Router();
router.use(requireAuth);

router.get('/matters/:id/arte/marca-overlay', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const Users = require('../models/Users');
    const user = await Users.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const title = String(req.query.titulo || req.query.title || matter.titulo || '').trim();
    if (!title) return res.status(400).json({ error: 'Informe o título para a marca' });

    const { buildBrandOverlayPng } = require('../services/editorialCardService');
    const png = await buildBrandOverlayPng({ title, user });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=20');
    return res.send(png);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte', (req, res, next) => {
  uploadMatterImage(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(uploadError.status || 400).json({ error: uploadError.message });
    }

    let storedSource = null;
    try {
      const matterId = Number(req.params.id);
      if (!Number.isInteger(matterId) || matterId < 1) {
        return res.status(400).json({ error: 'ID da matéria inválido' });
      }

      const matter = await AiMatters.findById(matterId);
      if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
        return res.status(404).json({ error: 'Matéria não encontrada' });
      }
      if (matter.status === 'publicado') {
        return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
      }
      if (!req.file) return res.status(400).json({ error: 'Selecione uma imagem para continuar' });

      storedSource = await storeMatterSourceImage({
        userId: req.session.userId,
        matterId,
        buffer: req.file.buffer,
      });
      const artwork = await composeMatterArtwork({
        userId: req.session.userId,
        matterId,
        sourceUrl: storedSource.publicUrl,
        title: String(req.body.titulo || matter.titulo || '').trim(),
        force: true,
      });

      const {
        atualizarCreditoImagemNaMateria,
        atualizarFonteCreditoDaImagem,
        CREDITO_IMAGEM_FALLBACK,
      } = require('../services/editorialGuidelinesFb');
      const fonte = {
        fonteNome: artwork.matter?.fonte_titulo || matter.fonte_titulo,
        fonteUrl: artwork.matter?.fonte_url || matter.fonte_url,
      };
      const materiaAtual = artwork.matter?.materia || matter.materia;
      const fonteCreditoAtual = artwork.matter?.fonte_credito ?? matter.fonte_credito;
      await AiMatters.update(matterId, {
        materia: atualizarCreditoImagemNaMateria(
          materiaAtual,
          CREDITO_IMAGEM_FALLBACK,
          fonte
        ),
        fonte_credito: atualizarFonteCreditoDaImagem(
          fonteCreditoAtual,
          CREDITO_IMAGEM_FALLBACK,
          fonte
        ),
      });
      artwork.matter = await AiMatters.findById(matterId);

      return res.json({
        ok: true,
        matter: artwork.matter,
        imagemUrl: artwork.publicUrl,
        hasLogo: artwork.hasLogo,
      });
    } catch (err) {
      if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
});

router.post('/matters/:id/arte/regenerar', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A arte de uma matéria publicada não pode ser alterada' });
    }

    const sourceUrl =
      matter.imagem_fonte_url ||
      (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || ''))
        ? matter.imagem_url
        : null);

    if (!sourceUrl) {
      return res.status(400).json({
        error: 'A foto original não está disponível. Escolha outra imagem para gerar a arte novamente.',
      });
    }

    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      title: matter.titulo,
      force: true,
      model: req.body?.modelo || req.body?.model || req.body?.arte_modelo || null,
      zoom: req.body?.zoom,
      offsetX: req.body?.offsetX ?? req.body?.offset_x,
      offsetY: req.body?.offsetY ?? req.body?.offset_y,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      arteModelo: artwork.modelId,
      hasLogo: artwork.hasLogo,
      titulo: artwork.matter?.titulo || matter.titulo,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte/enquadrar', async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A arte de uma matéria publicada não pode ser alterada' });
    }

    // Sempre a FOTO de origem — nunca a arte já composta com Minha marca (/media/artes/).
    let sourceUrl = String(matter.imagem_fonte_url || '').trim();
    if (/\/media\/artes\//i.test(sourceUrl)) {
      sourceUrl = '';
    }
    if (
      !sourceUrl &&
      !matter.imagem_path &&
      /^https?:\/\//i.test(String(matter.imagem_url || '')) &&
      !/\/media\/artes\//i.test(String(matter.imagem_url || ''))
    ) {
      sourceUrl = String(matter.imagem_url).trim();
    }

    if (!sourceUrl) {
      return res.status(400).json({
        error:
          'A foto original não está disponível para enquadrar. Escolha outra imagem (o zoom não pode usar a arte com marca).',
      });
    }

    const zoom = req.body?.zoom != null ? Number(req.body.zoom) : 100;
    const offsetX = req.body?.offsetX != null
      ? Number(req.body.offsetX)
      : req.body?.offset_x != null
        ? Number(req.body.offset_x)
        : 50;
    const offsetY = req.body?.offsetY != null
      ? Number(req.body.offsetY)
      : req.body?.offset_y != null
        ? Number(req.body.offset_y)
        : 50;

    // Zoom/pan só na foto; Minha marca é desenhada por cima depois (sem zoom).
    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      title: String(req.body?.titulo || matter.titulo || '').trim(),
      force: true,
      zoom,
      offsetX,
      offsetY,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: artwork.matter?.imagem_fonte_url || sourceUrl,
      arteModelo: artwork.modelId,
      hasLogo: artwork.hasLogo,
      zoom,
      offsetX,
      offsetY,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/matters/:id/arte/recortar', async (req, res, next) => {
  let storedSource = null;
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID da matéria inválido' });
    }

    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'A imagem de uma matéria publicada não pode ser alterada' });
    }

    let sourceUrl = String(matter.imagem_fonte_url || '').trim();
    if (/\/media\/artes\//i.test(sourceUrl)) sourceUrl = '';
    if (
      !sourceUrl &&
      !matter.imagem_path &&
      (/^https?:\/\//i.test(String(matter.imagem_url || '')) ||
        String(matter.imagem_url || '').startsWith('/media/fontes/')) &&
      !/\/media\/artes\//i.test(String(matter.imagem_url || ''))
    ) {
      sourceUrl = String(matter.imagem_url).trim();
    }
    if (!sourceUrl) {
      return res.status(400).json({
        error: 'A foto original não está disponível para recortar. Escolha outra imagem primeiro.',
      });
    }

    storedSource = await cropMatterSourceImage({
      userId: req.session.userId,
      matterId,
      sourceUrl,
      left: req.body?.left,
      top: req.body?.top,
      width: req.body?.width,
      height: req.body?.height,
    });

    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl: storedSource.publicUrl,
      title: String(req.body?.titulo || matter.titulo || '').trim(),
      force: true,
      zoom: 100,
      offsetX: 50,
      offsetY: 50,
    });

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      imagemFonteUrl: storedSource.publicUrl,
      hasLogo: artwork.hasLogo,
    });
  } catch (err) {
    if (storedSource) removeMatterSourceImage(storedSource.publicUrl);
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

function pageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id;
  return raw != null && raw !== '' ? Number(raw) : null;
}

function publicationType(body = {}) {
  return (body.tipoPublicacao ?? body.tipo_publicacao) === 'foto' ? 'foto' : 'texto';
}

async function addArtwork(userId, result) {
  return applyBrandArtworkToResult(userId, result);
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
    // null = editor nao mandou opiniao; vale a preferencia salva na materia.
    const pedidoInstagram =
      req.body.publicarInstagram ?? req.body.publicar_instagram ?? req.body.instagram ?? null;

    if (type === 'foto') {
      const title = String(req.body.titulo || matter.titulo || '').trim();
      const sourceUrl = matter.imagem_fonte_url ||
        (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || '')) ? matter.imagem_url : null);
      let imagemUrl = matter.imagem_url;
      if (sourceUrl) {
        const artwork = await composeMatterArtwork({
          userId,
          matterId: matter.id,
          sourceUrl,
          title,
          // Sempre regenera no republicar / para corrigir artes antigas 9:16
          force: true,
        });
        imagemUrl = artwork.publicUrl;
      } else if (!matter.imagem_path && !matter.imagem_url) {
        return res.status(422).json({ error: 'Gere a arte com título e logomarca antes de publicar' });
      }
      const published = await publishEditorialPhoto({
        userId,
        matterId: matter.id,
        facebookPageId,
        title,
        body: req.body.materia || matter.materia,
        publicarInstagram: pedidoInstagram,
      });
      return res.json({ ok: true, ...published, link: published.fbPostUrl, imagemUrl });
    }

    const published = await materiaIaService.publicarMateria(userId, matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: 'texto',
      titulo: req.body.titulo,
      materia: req.body.materia,
      sync: Boolean(req.body.sync),
      forcar: Boolean(req.body.forcar || req.body.republicar),
      publicar_instagram: pedidoInstagram,
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
