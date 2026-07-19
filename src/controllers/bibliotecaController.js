const bibliotecaService = require('../services/bibliotecaService');
const BibliotecaFontes = require('../models/BibliotecaFontes');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const BibliotecaAlertas = require('../models/BibliotecaAlertas');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');

async function pagesDoUsuario(userId) {
  const account = await FacebookAccounts.findByUser(userId);
  if (!account) return [];
  return FacebookPages.findByAccount(account.id);
}

async function listPage(req, res, next) {
  try {
    const data = await bibliotecaService.dashboardUsuario(req.session.userId);
    const pages = await pagesDoUsuario(req.session.userId);
    return res.render('biblioteca', {
      title: 'Biblioteca',
      ...data,
      pages,
    });
  } catch (err) {
    return next(err);
  }
}

async function fontePage(req, res, next) {
  try {
    const data = await bibliotecaService.detalheFonte(req.session.userId, Number(req.params.id));
    const pages = await pagesDoUsuario(req.session.userId);
    return res.render('biblioteca-fonte', {
      title: data.fonte.nome || 'Fonte',
      ...data,
      pages,
    });
  } catch (err) {
    if (err.status === 404) return res.redirect('/biblioteca');
    return next(err);
  }
}

async function listar(req, res, next) {
  try {
    const data = await bibliotecaService.dashboardUsuario(req.session.userId);
    res.json({ ok: true, ...data });
  } catch (err) {
    next(err);
  }
}

async function criar(req, res, next) {
  try {
    const body = req.body || {};
    const fonte = await bibliotecaService.criarFonte({
      userId: req.session.userId,
      url: body.url,
      nome: body.nome,
      notas: body.notas,
      monitorar: body.monitorar === true || body.monitorar === '1' || body.monitorar === 'on',
      intervaloMinutos: body.intervaloMinutos || body.intervalo_minutos,
      facebookPageId: body.facebookPageId || body.facebook_page_id || null,
    });
    res.status(201).json({ ok: true, fonte });
  } catch (err) {
    next(err);
  }
}

async function atualizar(req, res, next) {
  try {
    const fonte = await bibliotecaService.atualizarFonte(req.session.userId, Number(req.params.id), req.body || {});
    res.json({ ok: true, fonte });
  } catch (err) {
    next(err);
  }
}

async function remover(req, res, next) {
  try {
    const n = await BibliotecaFontes.deleteByUser(Number(req.params.id), req.session.userId);
    if (!n) return res.status(404).json({ error: 'Fonte não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function escanear(req, res, next) {
  try {
    const result = await bibliotecaService.escanearAgora(req.session.userId, Number(req.params.id));
    res.status(result.pending ? 202 : 200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function postsDaFonte(req, res, next) {
  try {
    const fonte = await BibliotecaFontes.findById(Number(req.params.id));
    if (!fonte || Number(fonte.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Fonte não encontrada' });
    }
    const posts = await BibliotecaPosts.findByFonte(fonte.id, 40);
    const pending = ['triggering', 'pending'].includes(String(fonte.scrape_status || ''));
    res.json({
      ok: true,
      posts,
      pending,
      scrape_status: fonte.scrape_status || null,
      scrape_error: pending ? null : fonte.scrape_error || null,
    });
  } catch (err) {
    next(err);
  }
}

async function gerarTexto(req, res, next) {
  try {
    const body = req.body || {};
    const gerado = await bibliotecaService.gerarTextoDePost({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId: body.facebookPageId || body.facebook_page_id || null,
      tipoPublicacao: body.tipoPublicacao === 'foto' ? 'foto' : 'texto',
    });
    res.status(201).json({
      ok: true,
      matter: gerado.matter,
      redirect: gerado.matter?.id ? `/materias-ia/${gerado.matter.id}` : '/minhas-materias',
      avisos: gerado.avisos || [],
    });
  } catch (err) {
    next(err);
  }
}

async function gerarVideo(req, res, next) {
  try {
    const body = req.body || {};
    const result = await bibliotecaService.gerarVideoDePost({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId: body.facebookPageId || body.facebook_page_id || null,
    });
    res.status(202).json({ ok: true, ...result, redirect: result.redirect || '/fila' });
  } catch (err) {
    next(err);
  }
}

async function publicarDireto(req, res, next) {
  try {
    const body = req.body || {};
    const result = await bibliotecaService.publicarPostDireto({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId: body.facebookPageId || body.facebook_page_id || null,
    });
    res.status(result.queued ? 202 : 200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function listarAlertas(req, res, next) {
  try {
    const apenasNaoLidos = req.query.unread === '1' || req.query.naoLidos === '1';
    const alertas = await BibliotecaAlertas.findByUser(req.session.userId, {
      apenasNaoLidos,
      limit: 40,
    });
    const countRow = await BibliotecaAlertas.countNaoLidos(req.session.userId);
    res.json({ ok: true, alertas, alertasNaoLidos: Number(countRow?.total || 0) });
  } catch (err) {
    next(err);
  }
}

async function marcarAlertaLido(req, res, next) {
  try {
    await BibliotecaAlertas.marcarLido(Number(req.params.id), req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function marcarTodosLidos(req, res, next) {
  try {
    await BibliotecaAlertas.marcarTodosLidos(req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function listarMelhores(req, res, next) {
  try {
    const melhores = await bibliotecaService.listarMelhoresParaPublicar(
      req.session.userId,
      Number(req.query.limit) || 30
    );
    res.json({ ok: true, melhores });
  } catch (err) {
    next(err);
  }
}

async function analisarMelhores(req, res, next) {
  try {
    const melhores = await bibliotecaService.analisarMelhoresParaPublicar(
      req.session.userId,
      Number(req.body?.limit) || 30
    );
    res.json({ ok: true, melhores });
  } catch (err) {
    next(err);
  }
}

async function ocultarMelhor(req, res, next) {
  try {
    const melhores = await bibliotecaService.ocultarMelhorParaPublicar(
      req.session.userId,
      Number(req.params.postId)
    );
    res.json({ ok: true, melhores });
  } catch (err) {
    next(err);
  }
}

async function getAutopilot(req, res, next) {
  try {
    const autopilot = await bibliotecaService.obterAutopilot(req.session.userId);
    res.json({ ok: true, autopilot });
  } catch (err) {
    next(err);
  }
}

async function putAutopilot(req, res, next) {
  try {
    const autopilot = await bibliotecaService.salvarAutopilot(req.session.userId, req.body || {});
    res.json({ ok: true, autopilot });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPage,
  fontePage,
  listar,
  criar,
  atualizar,
  remover,
  escanear,
  postsDaFonte,
  gerarTexto,
  gerarVideo,
  publicarDireto,
  listarAlertas,
  marcarAlertaLido,
  marcarTodosLidos,
  listarMelhores,
  analisarMelhores,
  ocultarMelhor,
  getAutopilot,
  putAutopilot,
};
