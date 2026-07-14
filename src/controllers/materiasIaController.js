const materiaIaService = require('../services/materiaIaService');
const AiMatters = require('../models/AiMatters');
const AiMonitors = require('../models/AiMonitors');
const { composeMatterArtwork } = require('../services/matterArtworkService');

function pickPageId(body = {}) {
  const raw = body.facebookPageId ?? body.facebook_page_id;
  return raw != null && raw !== '' ? Number(raw) : null;
}

function pickTipo(body = {}) {
  const raw = body.tipoPublicacao ?? body.tipo_publicacao ?? 'texto';
  return raw === 'foto' ? 'foto' : 'texto';
}

async function pesquisar(req, res, next) {
  try {
    const body = req.body || {};
    const palavrasChave = body.palavrasChave || body.palavras_chave;
    const quantidadePorNicho = body.quantidadePorNicho ?? body.quantidade_por_nicho ?? 5;
    const incluirRedes = Boolean(
      body.incluirRedes ?? body.incluirRedesSociais ?? body.incluir_redes_sociais
    );
    const somenteRedes = Boolean(
      body.somenteRedes ?? body.somenteRedesSociais ?? body.somente_redes_sociais
    );
    const diasRecentes = body.diasRecentes ?? body.dias_recentes;
    const periodo =
      body.periodo ||
      (diasRecentes ? `${Number(diasRecentes)}d` : '24h');
    const filtrarPeriodo = body.filtrarPeriodo !== false;
    const facebookPageId = pickPageId(body);

    if (!String(palavrasChave || '').trim()) {
      return res.status(400).json({ error: 'Informe palavras-chave' });
    }

    // trends / internacional: aceitos no body (extensão futura); Google News já cobre pt-BR
    void body.trends;
    void body.internacional;

    let topicos = await materiaIaService.pesquisarNichos(palavrasChave, quantidadePorNicho, {
      periodo,
      diasRecentes,
      incluirRedesSociais: incluirRedes,
      somenteRedesSociais: somenteRedes,
      filtrarPeriodo,
    });

    topicos = await materiaIaService.marcarJaPublicados(
      req.session.userId,
      facebookPageId,
      topicos
    );

    res.json({ ok: true, topicos });
  } catch (err) {
    next(err);
  }
}

async function emAlta(req, res, next) {
  try {
    const body = req.body || {};
    const palavrasExtras = body.palavrasExtras || body.palavras_extras || '';
    const horas = body.horas || 24;
    const facebookPageId = pickPageId(body);
    const result = await materiaIaService.buscarEmAltaAgora(palavrasExtras, { horas });
    const topicos = await materiaIaService.marcarJaPublicados(
      req.session.userId,
      facebookPageId,
      result.topicos || []
    );
    res.json({ ok: true, ...result, topicos });
  } catch (err) {
    next(err);
  }
}

async function gerar(req, res, next) {
  try {
    const body = req.body || {};
    const topico = body.topico;
    if (!topico || !topico.titulo) {
      return res.status(400).json({ error: 'Envie um tópico válido' });
    }

    const facebookPageId = pickPageId(body);
    const tipoPublicacao = pickTipo(body);
    const status = String(body.status || 'rascunho').toLowerCase() === 'publicado'
      ? 'publicado'
      : 'rascunho';

    if (status === 'publicado' && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    const result = await materiaIaService.gerarCompleto({
      userId: req.session.userId,
      topico,
      facebookPageId,
      tipoPublicacao,
      status,
      investigativa: Boolean(body.investigativa),
    });

    res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || null,
    });
  } catch (err) {
    next(err);
  }
}

async function gerarPreview(req, res, next) {
  try {
    const topico = req.body?.topico;
    if (!topico || !topico.titulo) {
      return res.status(400).json({ error: 'Envie um tópico válido' });
    }
    const tipo = pickTipo(req.body);
    const facebookPageId = pickPageId(req.body);
    const gerado = await materiaIaService.gerarPreviewDeTopico(topico, {
      userId: req.session.userId,
      facebookPageId,
      tipoPublicacao: tipo,
      investigativa: Boolean(req.body.investigativa),
    });
    const matter = await materiaIaService.salvarMateria({
      userId: req.session.userId,
      facebookPageId,
      gerado,
      topico: gerado.topico || topico,
      tipoPublicacao: tipo,
      status: 'rascunho',
    });
    res.json({
      ok: true,
      matter,
      artigo: {
        titulo: gerado.titulo,
        materia: gerado.materia,
        hashtags: gerado.hashtags,
        imagemUrl: gerado.imagemUrl,
        imagemOrigem: gerado.imagemOrigem || null,
        termos_imagem: gerado.termos_imagem || [],
      },
      avisos: [...(gerado.avisos || []), gerado.avisoFoto].filter(Boolean),
      qualidade: {
        chars: gerado._chars,
        ok: gerado._qualidadeOk,
        estilo: gerado._estilo,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function gerarLote(req, res, next) {
  try {
    const body = req.body || {};
    const { topicos } = body;
    const facebook_page_id = pickPageId(body);
    const tipo_publicacao = pickTipo(body);
    if (!Array.isArray(topicos) || !topicos.length) {
      return res.status(400).json({ error: 'Selecione ao menos um tópico' });
    }
    if (!facebook_page_id) {
      return res.status(400).json({ error: 'Selecione a página do Facebook' });
    }
    const result = await materiaIaService.gerarEPublicarLote({
      userId: req.session.userId,
      topicos,
      facebookPageId: facebook_page_id,
      tipoPublicacao: tipo_publicacao,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function publicar(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const body = req.body || {};
    const result = await materiaIaService.publicarMateria(req.session.userId, matterId, {
      facebook_page_id: pickPageId(body),
      tipo_publicacao: pickTipo(body),
      titulo: body.titulo,
      materia: body.materia,
      imagem_url: body.imagem_url || body.imagemUrl,
      sync: Boolean(body.sync),
    });
    res.status(result.queued ? 202 : 200).json({
      ok: true,
      ...result,
      link: result.fbPostUrl || null,
    });
  } catch (err) {
    next(err);
  }
}

async function listarMaterias(req, res, next) {
  try {
    const matters = await AiMatters.findByUser(req.session.userId, 40);
    res.json({ ok: true, matters });
  } catch (err) {
    next(err);
  }
}

async function removerMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    await AiMatters.deleteByUser(matterId, req.session.userId);
    res.json({ ok: true, id: matterId });
  } catch (err) {
    next(err);
  }
}

function parseHashtags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      /* texto livre */
    }
    return trimmed
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }
  return [];
}

async function atualizarMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const body = req.body || {};
    const patch = {};
    if (body.titulo != null) patch.titulo = String(body.titulo).trim().slice(0, 300);
    if (body.materia != null) patch.materia = String(body.materia);
    if (body.hashtags != null) patch.hashtags = JSON.stringify(parseHashtags(body.hashtags));
    if (body.tipoPublicacao != null || body.tipo_publicacao != null) {
      patch.tipo_publicacao = pickTipo(body);
    }
    if (body.facebookPageId != null || body.facebook_page_id != null) {
      patch.facebook_page_id = pickPageId(body);
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. Gere uma nova se precisar alterar.' });
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'Nada para atualizar' });
    }
    if (matter.status === 'agendado') {
      /* permite editar texto ainda agendado */
    } else if (['rascunho', 'pronto', 'erro'].includes(matter.status)) {
      patch.status = 'rascunho';
    }

    await AiMatters.update(matterId, patch);
    const updated = await AiMatters.findById(matterId);

    const titleChanged =
      body.titulo != null && String(body.titulo).trim() !== String(matter.titulo || '').trim();
    const sourceUrl =
      updated.imagem_fonte_url ||
      (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
        ? updated.imagem_url
        : null);

    if (titleChanged && sourceUrl) {
      try {
        const artwork = await composeMatterArtwork({
          userId: req.session.userId,
          matterId: updated.id,
          sourceUrl,
          title: updated.titulo,
          force: true,
        });
        return res.json({ ok: true, matter: artwork.matter, imagemUrl: artwork.publicUrl });
      } catch (err) {
        return res.json({
          ok: true,
          matter: updated,
          aviso: `Texto salvo, mas a arte não foi regenerada: ${err.message}`,
        });
      }
    }

    return res.json({ ok: true, matter: updated });
  } catch (err) {
    return next(err);
  }
}

async function showMatter(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    if (!Number.isInteger(matterId) || matterId < 1) {
      return res.status(404).render('404', { title: 'Não encontrado', path: req.path });
    }
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).render('404', { title: 'Não encontrado', path: req.path });
    }

    let hashtags = [];
    try {
      const raw = matter.hashtags;
      if (Array.isArray(raw)) hashtags = raw;
      else if (typeof raw === 'string' && raw.trim()) hashtags = JSON.parse(raw);
    } catch {
      hashtags = [];
    }

    return res.render('materia-ia-editar', {
      title: matter.titulo || 'Matéria IA',
      matter,
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    return next(err);
  }
}

async function listPage(req, res, next) {
  try {
    return res.render('materias-ia', {
      title: 'Gerar conteúdo IA',
      miaStandalone: true,
    });
  } catch (err) {
    return next(err);
  }
}

async function listMinhasMaterias(req, res, next) {
  try {
    const matters = await AiMatters.findByUser(req.session.userId, 100);
    return res.render('minhas-materias', {
      title: 'Minhas matérias',
      matters,
    });
  } catch (err) {
    return next(err);
  }
}

async function agendar(req, res, next) {
  try {
    const matterId = Number(req.params.id || req.body.matter_id);
    const body = req.body || {};

    if (body.titulo != null || body.materia != null) {
      const matter = await AiMatters.findById(matterId);
      if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
        return res.status(404).json({ error: 'Matéria não encontrada' });
      }
      const patch = {};
      if (body.titulo != null) patch.titulo = String(body.titulo).trim().slice(0, 300);
      if (body.materia != null) patch.materia = String(body.materia);
      if (Object.keys(patch).length) await AiMatters.update(matterId, patch);
    }

    const result = await materiaIaService.agendarMateria({
      userId: req.session.userId,
      matterId,
      runAt: body.run_at || body.runAt,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function monitorCriar(req, res, next) {
  try {
    const body = req.body || {};
    const monitor = await materiaIaService.criarMonitor({
      userId: req.session.userId,
      facebookPageId: pickPageId(body),
      palavrasChave: body.palavrasChave || body.palavras_chave,
      intervaloMinutos: body.intervaloMinutos || body.intervalo_minutos,
      postsPorCiclo: body.postsPorCiclo || body.posts_por_ciclo,
      tipoPublicacao: pickTipo(body),
      inicioEm: body.inicioEm || body.inicio_em,
      fimEm: body.fimEm || body.fim_em,
    });
    res.status(201).json({ ok: true, monitor });
  } catch (err) {
    next(err);
  }
}

async function monitorLista(req, res, next) {
  try {
    const monitores = await AiMonitors.findByUser(req.session.userId);
    res.json({ ok: true, monitores });
  } catch (err) {
    next(err);
  }
}

async function monitorPausar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const monitor = await AiMonitors.findById(id);
    if (!monitor || monitor.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Monitor não encontrado' });
    }
    await AiMonitors.update(id, { ativo: false });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function monitorRetomar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const monitor = await AiMonitors.findById(id);
    if (!monitor || monitor.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Monitor não encontrado' });
    }
    await AiMonitors.update(id, {
      ativo: true,
      proxima_execucao: new Date(),
      ultimo_erro: null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  pesquisar,
  emAlta,
  gerar,
  gerarPreview,
  gerarLote,
  publicar,
  listarMaterias,
  removerMateria,
  atualizarMateria,
  showMatter,
  listPage,
  listMinhasMaterias,
  agendar,
  monitorCriar,
  monitorLista,
  monitorPausar,
  monitorRetomar,
};
