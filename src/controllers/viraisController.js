const viraisService = require('../services/viraisJmService');
const { defaultPageForUser, defaultPageIdForUser } = require('../services/facebookPageResolver');
const { randomUUID } = require('node:crypto');

const pesquisasEmAndamento = new Map();
const PESQUISA_JOB_TTL_MS = 30 * 60 * 1000;

function limparPesquisasAntigas() {
  const limite = Date.now() - PESQUISA_JOB_TTL_MS;
  for (const [id, job] of pesquisasEmAndamento.entries()) {
    if (job.criadoEm < limite) pesquisasEmAndamento.delete(id);
  }
}

async function showPage(req, res, next) {
  try {
    const pagina = await defaultPageForUser(req.session.userId);
    return res.render('virais', {
      title: 'Virais',
      perfil: viraisService.PERFIL_PUBLICO,
      eixos: viraisService.EIXOS,
      paginaPadrao: pagina
        ? { id: Number(pagina.id), nome: pagina.page_name || 'Página do Facebook' }
        : null,
    });
  } catch (err) {
    return next(err);
  }
}

async function pesquisar(req, res, next) {
  try {
    const facebookPageId = await defaultPageIdForUser(req.session.userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina sua página padrão em Páginas antes de pesquisar pautas virais.',
      });
    }
    const resultado = await viraisService.pesquisarPautas({
      userId: req.session.userId,
      facebookPageId,
      eixo: req.body?.eixo || 'all',
      termo: req.body?.termo || req.body?.busca || '',
      periodo: req.body?.periodo || '7d',
      limite: req.body?.limite || 10,
    });
    return res.json({ ok: true, facebookPageId, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function iniciarPesquisa(req, res, next) {
  try {
    const userId = Number(req.session.userId);
    const facebookPageId = await defaultPageIdForUser(userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina sua página padrão em Páginas antes de pesquisar pautas virais.',
      });
    }
    limparPesquisasAntigas();
    const jobId = randomUUID();
    const job = {
      id: jobId,
      userId,
      facebookPageId,
      status: 'pesquisando',
      criadoEm: Date.now(),
      atualizadoEm: Date.now(),
      resultado: null,
      error: null,
    };
    pesquisasEmAndamento.set(jobId, job);

    // A resposta ao navegador é imediata. A pesquisa nativa do Claude continua
    // no servidor e pode ser acompanhada sem manter uma conexão HTTP pendurada.
    void viraisService
      .pesquisarPautas({
        userId,
        facebookPageId,
        eixo: req.body?.eixo || 'all',
        termo: req.body?.termo || req.body?.busca || '',
        periodo: req.body?.periodo || '7d',
        limite: req.body?.limite || 10,
      })
      .then((resultado) => {
        job.status = 'concluido';
        job.resultado = resultado;
        job.atualizadoEm = Date.now();
      })
      .catch((err) => {
        job.status = 'erro';
        job.error = err.message || 'Não foi possível concluir a pesquisa.';
        job.errorStatus = Number(err.status) || 500;
        job.atualizadoEm = Date.now();
      });

    return res.status(202).json({ ok: true, jobId, status: job.status });
  } catch (err) {
    return next(err);
  }
}

function statusPesquisa(req, res) {
  const job = pesquisasEmAndamento.get(String(req.params.jobId || ''));
  if (!job || Number(job.userId) !== Number(req.session.userId)) {
    return res.status(404).json({ error: 'Pesquisa não encontrada ou expirada.' });
  }
  if (job.status === 'erro') {
    pesquisasEmAndamento.delete(job.id);
    return res.status(job.errorStatus || 500).json({ error: job.error });
  }
  if (job.status === 'concluido') {
    pesquisasEmAndamento.delete(job.id);
    return res.json({
      ok: true,
      status: job.status,
      facebookPageId: job.facebookPageId,
      ...job.resultado,
    });
  }
  return res.status(202).json({
    ok: true,
    status: job.status,
    decorridoMs: Date.now() - job.criadoEm,
  });
}

async function gerar(req, res, next) {
  try {
    const facebookPageId = await defaultPageIdForUser(req.session.userId);
    if (!facebookPageId) {
      return res.status(400).json({
        error: 'Defina sua página padrão em Páginas antes de criar as matérias.',
      });
    }
    const resultado = await viraisService.gerarRascunhos({
      userId: req.session.userId,
      facebookPageId,
      pautas: req.body?.pautas,
      tom: req.body?.tom || 'natural',
      periodo: req.body?.periodo || '7d',
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = { showPage, pesquisar, iniciarPesquisa, statusPesquisa, gerar };
