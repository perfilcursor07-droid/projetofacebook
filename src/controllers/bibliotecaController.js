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

async function defaultPageIdDoUsuario(userId) {
  const { defaultPageIdForUser } = require('../services/facebookPageResolver');
  return defaultPageIdForUser(userId);
}

async function resolveFacebookPageId(userId, raw) {
  const { resolvePageForUser } = require('../services/facebookPageResolver');
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    const page = await resolvePageForUser(userId, n);
    if (page) return Number(page.id);
  }
  return defaultPageIdDoUsuario(userId);
}

async function listPage(req, res, next) {
  try {
    const userId = req.session.userId;
    const [data, pages] = await Promise.all([
      bibliotecaService.dashboardUsuario(userId),
      pagesDoUsuario(userId),
    ]);
    let defaultPageId = null;
    try {
      const Users = require('../models/Users');
      const stored = await Users.getDefaultFacebookPageId(userId);
      if (stored && pages.some((p) => Number(p.id) === Number(stored))) {
        defaultPageId = Number(stored);
      } else if (pages.length === 1) {
        defaultPageId = Number(pages[0].id);
      }
    } catch {
      defaultPageId = pages[0] ? Number(pages[0].id) : null;
    }
    return res.render('biblioteca', {
      title: 'Biblioteca',
      ...data,
      pages,
      defaultPageId,
    });
  } catch (err) {
    return next(err);
  }
}

async function fontePage(req, res, next) {
  try {
    const data = await bibliotecaService.detalheFonte(req.session.userId, Number(req.params.id));
    const pages = await pagesDoUsuario(req.session.userId);
    const defaultPageId = await defaultPageIdDoUsuario(req.session.userId);
    return res.render('biblioteca-fonte', {
      title: data.fonte.nome || 'Fonte',
      ...data,
      pages,
      defaultPageId,
    });
  } catch (err) {
    if (err.status === 404) return res.redirect('/biblioteca');
    return next(err);
  }
}

async function postPage(req, res, next) {
  try {
    const data = await bibliotecaService.detalhePost(req.session.userId, Number(req.params.postId));
    const pages = await pagesDoUsuario(req.session.userId);
    const defaultPageId = await defaultPageIdDoUsuario(req.session.userId);
    // Marca alerta ligado a este post como lido (se existir)
    await BibliotecaAlertas.marcarLidoPorPost(data.post.id, req.session.userId);
    return res.render('biblioteca-post', {
      title: data.post.titulo || 'Notícia',
      ...data,
      pages,
      defaultPageId,
    });
  } catch (err) {
    if (err.status === 404) return res.redirect('/biblioteca');
    return next(err);
  }
}

async function prepararPage(req, res, next) {
  try {
    const postId = Number(req.params.postId);
    if (!Number.isInteger(postId) || postId < 1) {
      return res.redirect('/biblioteca');
    }
    const post = await BibliotecaPosts.findById(postId);
    if (!post || Number(post.user_id) !== Number(req.session.userId)) {
      return res.redirect('/biblioteca');
    }
    const media = String(req.query.media || '').toLowerCase() === 'video' ? 'video' : 'post';
    let facebookPageId = req.query.facebook_page_id || req.query.page || null;
    if (!facebookPageId) {
      facebookPageId = await defaultPageIdDoUsuario(req.session.userId);
    }
    return res.render('biblioteca-preparar', {
      title: media === 'video' ? 'Preparando Reel…' : 'Preparando matéria…',
      postId,
      media,
      facebookPageId,
    });
  } catch (err) {
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
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebookPageId || body.facebook_page_id
    );
    const fonte = await bibliotecaService.criarFonte({
      userId: req.session.userId,
      url: body.url,
      nome: body.nome,
      notas: body.notas,
      monitorar: body.monitorar === true || body.monitorar === '1' || body.monitorar === 'on',
      intervaloMinutos: body.intervaloMinutos || body.intervalo_minutos,
      facebookPageId,
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
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebookPageId || body.facebook_page_id
    );
    const gerado = await bibliotecaService.gerarTextoDePost({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId,
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
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebookPageId || body.facebook_page_id
    );
    const result = await bibliotecaService.gerarVideoDePost({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId,
    });
    res.status(202).json({ ok: true, ...result, redirect: result.redirect || '/fila' });
  } catch (err) {
    next(err);
  }
}

async function publicarDireto(req, res, next) {
  try {
    const body = req.body || {};
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebookPageId || body.facebook_page_id
    );
    const result = await bibliotecaService.publicarPostDireto({
      userId: req.session.userId,
      postId: Number(req.params.postId),
      facebookPageId,
    });
    res.status(result.queued ? 202 : 200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function listarAlertas(req, res, next) {
  try {
    const Users = require('../models/Users');
    const apenasNaoLidos =
      req.query.unread === '1' ||
      req.query.naoLidos === '1' ||
      req.query.tab === 'nao-lidos';
    const apenasLidos =
      req.query.read === '1' ||
      req.query.lido === '1' ||
      req.query.lidos === '1' ||
      req.query.tab === 'lidos';
    const filtrarNaoLidos = apenasNaoLidos && !apenasLidos;
    const filtrarLidos = apenasLidos && !apenasNaoLidos;
    const user = await Users.findById(req.session.userId);
    const savedKeywords = String(user?.biblioteca_alertas_keywords || '').trim();
    const keywordsRaw =
      req.query.keywords != null || req.query.q != null || req.query.palavras != null
        ? req.query.keywords || req.query.q || req.query.palavras || ''
        : savedKeywords;
    const keywords = String(keywordsRaw || '').trim();
    const hasKeywords = keywords.length > 0;
    const fora =
      req.query.fora === '1' ||
      req.query.exclude === '1' ||
      req.query.modo === 'fora' ||
      req.query.modo === 'outros';
    const excludeKeywords = Boolean(hasKeywords && fora);
    const alertas = await BibliotecaAlertas.findByUser(req.session.userId, {
      apenasNaoLidos: filtrarNaoLidos,
      apenasLidos: filtrarLidos,
      keywords: hasKeywords ? keywords : null,
      excludeKeywords,
      limit: hasKeywords ? 100 : 50,
    });
    const [countRow, countLidosRow] = await Promise.all([
      BibliotecaAlertas.countNaoLidos(req.session.userId, hasKeywords ? keywords : null, {
        excludeKeywords,
      }),
      BibliotecaAlertas.countLidos(req.session.userId, hasKeywords ? keywords : null, {
        excludeKeywords,
      }),
    ]);
    res.json({
      ok: true,
      alertas,
      alertasNaoLidos: Number(countRow?.total || 0),
      alertasLidos: Number(countLidosRow?.total || 0),
      keywords,
      keywordsSalvas: savedKeywords,
      keywordsList: require('../models/BibliotecaAlertas').parseKeywords(savedKeywords),
      fora: excludeKeywords,
    });
  } catch (err) {
    next(err);
  }
}

async function salvarAlertasKeywords(req, res, next) {
  try {
    const Users = require('../models/Users');
    const { parseKeywords, serializeKeywords } = require('../models/BibliotecaAlertas');
    const raw = req.body?.keywords != null
      ? req.body.keywords
      : (req.body?.palavras != null ? req.body.palavras : req.body?.lista);
    const parsed = parseKeywords(raw);
    const value = serializeKeywords(parsed);
    await Users.update(req.session.userId, { biblioteca_alertas_keywords: value });
    const alertas = await BibliotecaAlertas.findByUser(req.session.userId, {
      apenasNaoLidos: true,
      keywords: value,
      limit: value ? 100 : 50,
    });
    const [countRow, countLidosRow] = await Promise.all([
      BibliotecaAlertas.countNaoLidos(req.session.userId, value),
      BibliotecaAlertas.countLidos(req.session.userId, value),
    ]);
    res.json({
      ok: true,
      keywords: value || '',
      keywordsSalvas: value || '',
      keywordsList: parsed,
      alertas,
      alertasNaoLidos: Number(countRow?.total || 0),
      alertasLidos: Number(countLidosRow?.total || 0),
    });
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
    const Users = require('../models/Users');
    const user = await Users.findById(req.session.userId);
    const savedKeywords = String(user?.biblioteca_alertas_keywords || '').trim();
    const body = req.body || {};
    const keywordsRaw =
      body.keywords != null || body.palavras != null
        ? body.keywords ?? body.palavras
        : savedKeywords;
    const keywords = String(keywordsRaw || '').trim();
    const fora =
      body.fora === true ||
      body.fora === 1 ||
      body.fora === '1' ||
      body.exclude === true ||
      body.modo === 'fora';
    await BibliotecaAlertas.marcarTodosLidos(req.session.userId, keywords || null, {
      excludeKeywords: Boolean(keywords && fora),
    });
    res.json({ ok: true, fora: Boolean(keywords && fora) });
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
    const result = await bibliotecaService.analisarMelhoresParaPublicar(
      req.session.userId,
      Number(req.body?.limit) || 30
    );
    const melhores = Array.isArray(result) ? result : result?.melhores || [];
    const scan = Array.isArray(result) ? null : result?.scan || null;
    res.json({ ok: true, melhores, scan });
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

async function agendarPage(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const Users = require('../models/Users');
    const rawAba = String(req.query.aba || 'agendada').toLowerCase();
    const aba =
      rawAba === 'publicadas' || rawAba === 'publicado'
        ? 'publicadas'
        : rawAba === 'viralizadas' || rawAba === 'viralizou' || rawAba === 'viral'
          ? 'viralizadas'
          : 'agendada';

    const UsersFind = Users.findById(req.session.userId);
    const pagesP = pagesDoUsuario(req.session.userId);
    const defaultPageP = defaultPageIdDoUsuario(req.session.userId);
    const contagensP = agendaService.contagensAgenda(req.session.userId);

    let itens = [];
    let viralizadas = [];
    if (aba === 'viralizadas') {
      // Sync + lista primeiro; contagem depois (senão o badge fica 0 com engajamento ainda null)
      const viralizadas = await agendaService.listarViralizadas(req.session.userId, {
        limit: 40,
        sync: true,
      });
      const [contagens, pages, defaultPageId, user] = await Promise.all([
        agendaService.contagensAgenda(req.session.userId),
        pagesP,
        defaultPageP,
        UsersFind,
      ]);
      // Badge usa o tamanho real da lista se a contagem ainda estiver desatualizada
      if (contagens && Number(contagens.viralizadas) < viralizadas.length) {
        contagens.viralizadas = viralizadas.length;
      }
      const keywordsRaw = String(user?.biblioteca_alertas_keywords || '').trim();
      const keywordsList = BibliotecaAlertas.parseKeywords(keywordsRaw);
      return res.render('biblioteca-agendar', {
        title: 'Agendar',
        itens: [],
        viralizadas,
        contagens,
        aba,
        pages,
        defaultPageId,
        keywordsList,
        keywordsSalvas: keywordsRaw,
      });
    }

    const [itensAgenda, contagens, pages, defaultPageId, user] = await Promise.all([
      agendaService.listarAgenda(req.session.userId, { aba }),
      contagensP,
      pagesP,
      defaultPageP,
      UsersFind,
    ]);
    itens = itensAgenda;
    const keywordsRaw = String(user?.biblioteca_alertas_keywords || '').trim();
    const keywordsList = BibliotecaAlertas.parseKeywords(keywordsRaw);
    return res.render('biblioteca-agendar', {
      title: 'Agendar',
      itens,
      viralizadas: [],
      contagens,
      aba,
      pages,
      defaultPageId,
      keywordsList,
      keywordsSalvas: keywordsRaw,
    });
  } catch (err) {
    return next(err);
  }
}

async function listarAgenda(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const aba = req.query.aba || req.query.status || 'agendada';
    const [itens, contagens] = await Promise.all([
      agendaService.listarAgenda(req.session.userId, { aba }),
      agendaService.contagensAgenda(req.session.userId),
    ]);
    res.json({ ok: true, itens, contagens, aba });
  } catch (err) {
    next(err);
  }
}

async function montarAgenda(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const body = req.body || {};
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebook_page_id ?? body.facebookPageId
    );
    const result = await agendaService.montarAgendaAmanha({
      userId: req.session.userId,
      facebookPageId,
      maxItens: body.max_itens ?? body.maxItens ?? 20,
      startHour: body.start_hour ?? body.startHour ?? 7,
      endHour: body.end_hour ?? body.endHour ?? 22,
      somenteSites: body.somente_sites !== false && body.somenteSites !== false,
      usarKeywords:
        body.usar_keywords === true ||
        body.usarKeywords === true ||
        body.usar_keywords === 1 ||
        body.usar_keywords === '1' ||
        body.filtrar_keywords === true,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status === 422) {
      return res.status(422).json({ error: err.message, ok: false });
    }
    return next(err);
  }
}

async function compactarAgenda(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const result = await agendaService.compactarHorariosAbertos(req.session.userId);
    const itens = await agendaService.listarAgenda(req.session.userId, {
      aba: 'agendada',
      reparar: false,
    });
    const det = (result.detalhes || []).find((d) => (d.ajustados || 0) > 0) || (result.detalhes || [])[0];
    let mensagem =
      (result.ajustados || 0) > 0
        ? `${result.ajustados} horário(s) reorganizado(s) de 30 em 30 min.`
        : 'Horários já estavam em sequência de 30 em 30 min.';
    if (det?.depois?.length) {
      mensagem += ` Agora: ${det.depois.map((k) => k.slice(11)).join(' → ')}`;
    }
    res.json({
      ok: true,
      ajustados: result.ajustados || 0,
      mensagem,
      itens,
      contagens: await agendaService.contagensAgenda(req.session.userId),
    });
  } catch (err) {
    return next(err);
  }
}

async function limparAgendaSemKeyword(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const result = await agendaService.limparItensSemPalavraChave(req.session.userId, {
      statuses: ['pendente', 'confirmado'],
      compactar: true,
    });
    const itens = await agendaService.listarAgenda(req.session.userId, {
      aba: 'agendada',
      reparar: false,
    });
    res.json({
      ok: true,
      ...result,
      mensagem:
        result.removidos > 0
          ? `Removidos ${result.removidos} item(ns) que não batem nas suas palavras-chave.`
          : 'Nenhum item fora das palavras-chave na agenda.',
      itens,
      contagens: await agendaService.contagensAgenda(req.session.userId),
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message, ok: false });
    }
    return next(err);
  }
}

async function atualizarAgendaItem(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const id = Number(req.params.id);
    const proposedAt = req.body?.proposed_at ?? req.body?.proposedAt;
    if (!proposedAt) {
      const err = new Error('Informe proposed_at');
      err.status = 400;
      throw err;
    }
    const result = await agendaService.atualizarHorario(req.session.userId, id, proposedAt);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function confirmarAgendaItem(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const result = await agendaService.confirmarAgendamento(
      req.session.userId,
      Number(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function publicarAgendaItem(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const result = await agendaService.publicarAgora(req.session.userId, Number(req.params.id));
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function excluirAgendaItem(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const apagarMateria =
      req.body?.apagar_materia === true || req.query.apagar_materia === '1';
    const result = await agendaService.excluirItem(req.session.userId, Number(req.params.id), {
      apagarMateria,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function loteAgenda(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const result = await agendaService.acaoEmLote(req.session.userId, {
      ids: req.body?.ids,
      acao: req.body?.acao,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** Lista matérias viralizadas (qualquer Página) prontas para agendar com variação. */
async function listarViralizadasAgenda(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const itens = await agendaService.listarViralizadas(req.session.userId, {
      limit: Number(req.query.limit) || 40,
    });
    res.json({ ok: true, itens });
  } catch (err) {
    next(err);
  }
}

/** Diagnóstico: por que a aba Viralizadas está vazia? */
async function viralizadasDebug(req, res) {
  try {
    const AiMatters = require('../models/AiMatters');
    const agendaService = require('../services/bibliotecaAgendaService');
    const before = await AiMatters.diagnosticoEngajamentoConta(req.session.userId);
    let sync = null;
    try {
      sync = await require('../services/materiaIaService').sincronizarEngajamentoRecentes(
        req.session.userId,
        { limit: 25, concurrency: 2 }
      );
    } catch (err) {
      sync = { erro: err.message };
    }
    const after = await AiMatters.diagnosticoEngajamentoConta(req.session.userId);
    const lista = await agendaService.listarViralizadas(req.session.userId, {
      limit: 10,
      sync: false,
    });
    res.json({
      ok: true,
      antes: before,
      sync,
      depois: after,
      amostraLista: lista,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}

/**
 * Reescreve a viralizada (anti-plágio + marca do perfil) e pré-agenda na Página escolhida.
 */
async function agendarViralizada(req, res, next) {
  try {
    const agendaService = require('../services/bibliotecaAgendaService');
    const body = req.body || {};
    const matterId = Number(req.params.matterId || body.matter_id || body.origem_matter_id);
    const facebookPageId = await resolveFacebookPageId(
      req.session.userId,
      body.facebook_page_id ?? body.facebookPageId
    );
    const result = await agendaService.agendarViralizada({
      userId: req.session.userId,
      origemMatterId: matterId,
      facebookPageId,
      proposedAt: body.proposed_at ?? body.proposedAt ?? null,
      confirmar: body.confirmar === true || body.confirmar === 1 || body.confirmar === '1',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPage,
  fontePage,
  postPage,
  prepararPage,
  agendarPage,
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
  salvarAlertasKeywords,
  marcarAlertaLido,
  marcarTodosLidos,
  listarMelhores,
  analisarMelhores,
  ocultarMelhor,
  getAutopilot,
  putAutopilot,
  listarAgenda,
  montarAgenda,
  compactarAgenda,
  limparAgendaSemKeyword,
  atualizarAgendaItem,
  confirmarAgendaItem,
  publicarAgendaItem,
  excluirAgendaItem,
  loteAgenda,
  listarViralizadasAgenda,
  viralizadasDebug,
  agendarViralizada,
};
