const Users = require('../models/Users');
const viralizarService = require('../services/viralizarService');

function pickPageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id ?? body.pageId ?? null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function resolvePageId(userId, body = {}) {
  const fromBody = pickPageId(body);
  if (fromBody) return fromBody;
  return Users.getDefaultFacebookPageId(userId);
}

async function page(req, res, next) {
  try {
    return res.render('viralizar', {
      title: 'Conteúdo Viralizar',
      perfil: viralizarService.PERFIL_VIRAL,
      slotSugerido: viralizarService.proximoSlotSugerido(),
    });
  } catch (err) {
    return next(err);
  }
}

async function curar(req, res, next) {
  try {
    const body = req.body || {};
    const facebookPageId = await resolvePageId(req.session.userId, body);
    const result = await viralizarService.curarPautasVirais({
      userId: req.session.userId,
      facebookPageId,
      limit: body.limit || body.limite || 12,
    });
    res.json({ ok: true, facebookPageId, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, avisos: err.avisos || [] });
    }
    return next(err);
  }
}

async function gerar(req, res, next) {
  try {
    const body = req.body || {};
    const facebookPageId = await resolvePageId(req.session.userId, body);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Selecione a página padrão em /paginas antes de gerar.',
      });
    }

    const publicar =
      body.publicar === true ||
      body.publicar === '1' ||
      body.status === 'publicado' ||
      body.autoPublicar === true;

    const result = await viralizarService.gerarDePautas({
      userId: req.session.userId,
      facebookPageId,
      topicos: body.topicos || (body.topico ? [body.topico] : []),
      tipoPublicacao: body.tipoPublicacao || body.tipo_publicacao || 'foto',
      publicar,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function perfil(req, res) {
  res.json({
    ok: true,
    perfil: viralizarService.PERFIL_VIRAL,
    taxonomia: viralizarService.TAXONOMIA.map((t) => ({
      id: t.id,
      label: t.label,
      peso: t.peso,
    })),
    slotSugerido: viralizarService.proximoSlotSugerido(),
  });
}

module.exports = {
  page,
  curar,
  gerar,
  perfil,
};
