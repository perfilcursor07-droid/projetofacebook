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
  if (raw === 'foto') return 'foto';
  if (raw === 'reel') return 'reel';
  if (raw === 'auto') return 'auto';
  return 'texto';
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
      furoReportagem: Boolean(body.furoReportagem || body.furo_reportagem),
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

async function reescreverLink(req, res, next) {
  try {
    const body = req.body || {};
    const url = body.url || body.link;
    if (!String(url || '').trim()) {
      return res.status(400).json({ error: 'Cole o link da notícia' });
    }

    const facebookPageId = pickPageId(body);
    const tipoPublicacao = pickTipo(body);
    const status = String(body.status || 'rascunho').toLowerCase() === 'publicado'
      ? 'publicado'
      : 'rascunho';

    if (status === 'publicado' && !facebookPageId) {
      return res.status(400).json({ error: 'Selecione a página do Facebook para publicar' });
    }

    const result = await materiaIaService.gerarDeLink({
      userId: req.session.userId,
      url,
      facebookPageId,
      tipoPublicacao,
      status,
      textoManual: body.textoManual || body.legenda || body.texto || '',
      imagemManual: body.imagemManual || body.imagemUrl || body.imagem || '',
    });

    // Reel: AiMatter + processamento em background → /materias-ia/:id
    if (result.modo === 'reel') {
      return res.status(result.queued ? 202 : 200).json({
        ok: true,
        modo: 'reel',
        queued: result.queued,
        matter: result.matter,
        video: result.video,
        clip: result.clip || null,
        redirect: result.redirect || (result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias'),
        aviso: result.aviso,
      });
    }

    res.json({
      ok: true,
      ...result,
      preview: result.artigo,
      link: result.fbPostUrl || null,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
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
    const matter = await AiMatters.findById(matterId);
    const tipoBody = pickTipo(body);
    // Se a matéria já é reel, nunca deixa o body forçar texto
    const tipo =
      matter?.tipo_publicacao === 'reel' ? 'reel' : tipoBody === 'auto' ? matter?.tipo_publicacao : tipoBody;

    const result = await materiaIaService.publicarMateria(req.session.userId, matterId, {
      facebook_page_id: pickPageId(body),
      tipo_publicacao: tipo || matter?.tipo_publicacao || 'texto',
      titulo: body.titulo,
      materia: body.materia,
      imagem_url: body.imagem_url || body.imagemUrl,
      sync: Boolean(body.sync),
      forcar: Boolean(body.forcar || body.republicar),
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

async function obterMateria(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    res.json({ ok: true, matter });
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
      const t = pickTipo(body);
      patch.tipo_publicacao =
        matter.tipo_publicacao === 'reel' ? 'reel' : t === 'auto' || t === 'reel' ? matter.tipo_publicacao : t;
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

    // Aprende com edições humanas vs snapshot da IA (silencioso)
    if (body.titulo != null || body.materia != null) {
      try {
        const { registrarAprendizado } = require('../services/editorialLearningService');
        const tituloAntes = matter.titulo_ia != null ? matter.titulo_ia : matter.titulo;
        const materiaAntes = matter.materia_ia != null ? matter.materia_ia : matter.materia;
        await registrarAprendizado({
          userId: req.session.userId,
          matterId,
          tituloAntes: body.titulo != null ? tituloAntes : null,
          tituloDepois: body.titulo != null ? updated.titulo : null,
          materiaAntes: body.materia != null ? materiaAntes : null,
          materiaDepois: body.materia != null ? updated.materia : null,
        });
      } catch (err) {
        console.warn('[editorial-learning] salvar:', err.message);
      }
    }

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

    const { anexarHashtagsAoFinal } = require('../services/editorialGuidelinesFb');
    if (Array.isArray(hashtags) && hashtags.length) {
      matter.materia = anexarHashtagsAoFinal(matter.materia || '', hashtags);
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
      title: 'Criar conteúdo',
      miaStandalone: true,
    });
  } catch (err) {
    return next(err);
  }
}

async function showLotePage(req, res, next) {
  try {
    return res.render('conteudo-lote', {
      title: 'Gerando matérias',
      currentPath: '/conteudo',
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

/** Sugere outro título via IA (tom opcional) e regenera a arte Minha marca. */
async function sugerirTitulo(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. Gere uma nova se precisar alterar o título.' });
    }

    const deepseekService = require('../services/deepseekService');
    deepseekService.assertDeepseek();

    const tom = String(req.body?.tom || 'natural').trim().toLowerCase();
    const evitar = Array.isArray(req.body?.evitar) ? req.body.evitar : [];
    const tituloNaTela = String(req.body?.tituloAtual || '').trim();
    const tituloAtual = tituloNaTela || String(matter.titulo || '').trim();
    const materiaNaTela = String(req.body?.materia || '').trim();

    const sugerido = await deepseekService.sugerirTituloMateria({
      tituloAtual,
      materia: materiaNaTela || matter.materia,
      fonteTitulo: matter.fonte_titulo,
      tom,
      evitar: [...evitar, matter.titulo, tituloAtual].filter(Boolean),
    });

    const patch = {
      titulo: sugerido.titulo,
      titulo_ia: sugerido.titulo,
      error_message: null,
    };
    if (matter.status !== 'agendado') patch.status = 'rascunho';
    await AiMatters.update(matterId, patch);

    let updated = await AiMatters.findById(matterId);
    let imagemUrl = updated.imagem_url || null;
    let videoUrl = null;
    let aviso = null;

    // Reel: regenera capa no início do vídeo com modelo Minha marca + novo título
    if (updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
      try {
        const { applyCoverToClipNow } = require('../services/clipPostProcessService');
        await applyCoverToClipNow({
          clipId: updated.video_clip_id,
          userId: req.session.userId,
          titulo: sugerido.titulo,
          force: true,
        });
        updated = await AiMatters.findById(matterId);
        if (updated.video_path) {
          videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
        }
        aviso = 'Novo título aplicado e capa do Reel atualizada (Minha marca) ✓';
      } catch (err) {
        aviso = `Título atualizado, mas a capa do Reel não foi regenerada: ${err.message}`;
      }
    } else {
      const sourceUrl =
        updated.imagem_fonte_url ||
        (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
          ? updated.imagem_url
          : null);

      if (sourceUrl) {
        try {
          const artwork = await composeMatterArtwork({
            userId: req.session.userId,
            matterId: updated.id,
            sourceUrl,
            title: sugerido.titulo,
            force: true,
          });
          updated = artwork.matter;
          imagemUrl = artwork.publicUrl;
        } catch (err) {
          aviso = `Título atualizado, mas a arte não foi regenerada: ${err.message}`;
        }
      } else {
        aviso =
          'Título atualizado. Para gravar o título na arte, escolha uma imagem e aplique Minha marca.';
      }
    }

    return res.json({
      ok: true,
      titulo: sugerido.titulo,
      tom: sugerido.tom,
      matter: updated,
      imagemUrl,
      videoUrl,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Rebusca a capa na URL da fonte e aplica Minha marca. */
async function buscarImagemFonte(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. A imagem não pode ser alterada.' });
    }

    const fonteUrl = String(req.body?.url || matter.fonte_url || '').trim();
    if (!/^https?:\/\//i.test(fonteUrl)) {
      return res.status(400).json({
        error: 'Esta matéria não tem URL de fonte. Cole o link da notícia ou envie uma imagem manualmente.',
      });
    }

    const { extrairMetadadosArtigo } = require('../services/articleSource');
    const meta = await extrairMetadadosArtigo(fonteUrl);
    if (!meta?.imagem) {
      return res.status(422).json({
        error:
          'Não encontramos foto de capa nessa página. Escolha uma imagem manualmente ou tente outro link da notícia.',
      });
    }

    const patch = {
      imagem_url: meta.imagem,
      error_message: null,
    };
    if (meta.titulo && (!matter.fonte_titulo || /^not[ií]cia\s*[—\-]/i.test(matter.fonte_titulo))) {
      patch.fonte_titulo = meta.titulo;
    }
    if (meta.url && meta.url !== matter.fonte_url) {
      patch.fonte_url = meta.url;
    }
    if (matter.status !== 'agendado') patch.status = 'rascunho';
    await AiMatters.update(matterId, patch);

    let updated = await AiMatters.findById(matterId);
    let imagemUrl = meta.imagem;
    let aviso = null;

    try {
      const artwork = await composeMatterArtwork({
        userId: req.session.userId,
        matterId: updated.id,
        sourceUrl: meta.imagem,
        title: updated.titulo,
        force: true,
      });
      updated = artwork.matter;
      imagemUrl = artwork.publicUrl;
    } catch (err) {
      aviso = `Imagem da fonte encontrada, mas a arte Minha marca falhou: ${err.message}`;
    }

    return res.json({
      ok: true,
      matter: updated,
      imagemUrl,
      imagemFonte: meta.imagem,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** IA analisa a matéria e sugere fotos reais (Google Images via Serper). */
async function sugerirImagens(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const { sugerirImagensParaMateria } = require('../services/imageSuggestService');
    const imagemAtual =
      matter.imagem_fonte_url ||
      (!matter.imagem_path && /^https?:\/\//i.test(String(matter.imagem_url || ''))
        ? matter.imagem_url
        : null);

    const result = await sugerirImagensParaMateria({
      titulo: matter.titulo,
      materia: matter.materia,
      fonteTitulo: matter.fonte_titulo,
      imagemAtual,
      limite: Math.min(Number(req.body?.limite) || 12, 18),
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Aplica URL de imagem sugerida e gera arte Minha marca. */
async function aplicarImagemUrl(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({ error: 'Matéria já publicada. A imagem não pode ser alterada.' });
    }

    const imageUrl = String(req.body?.imageUrl || req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(imageUrl)) {
      return res.status(400).json({ error: 'Informe a URL da imagem sugerida' });
    }

    const title = String(req.body?.titulo || matter.titulo || '').trim();
    const artwork = await composeMatterArtwork({
      userId: req.session.userId,
      matterId,
      sourceUrl: imageUrl,
      title,
      force: true,
    });

    // Crédito da imagem: autor dos metadados internos, senão Reprodução/Internet
    const deepseekService = require('../services/deepseekService');
    const {
      atualizarCreditoImagemNaMateria,
      CREDITO_IMAGEM_FALLBACK,
    } = require('../services/editorialGuidelinesFb');
    let imagemAutor = CREDITO_IMAGEM_FALLBACK;
    try {
      const identificado = await deepseekService.identificarAutorImagem({
        autor: req.body?.autor || null,
        fonte: req.body?.fonte || null,
        titulo: req.body?.imagemTitulo || req.body?.title || null,
        origem: req.body?.origem || null,
      });
      imagemAutor = identificado || CREDITO_IMAGEM_FALLBACK;
    } catch {
      imagemAutor = CREDITO_IMAGEM_FALLBACK;
    }

    const materiaAtual = artwork.matter?.materia || matter.materia;
    const materiaComCredito = atualizarCreditoImagemNaMateria(materiaAtual, imagemAutor);
    if (materiaComCredito && materiaComCredito !== materiaAtual) {
      await AiMatters.update(matterId, { materia: materiaComCredito });
      artwork.matter = await AiMatters.findById(matterId);
    }

    return res.json({
      ok: true,
      matter: artwork.matter,
      imagemUrl: artwork.publicUrl,
      hasLogo: artwork.hasLogo,
      imagemAutor,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Reescreve a matéria incorporando informações avulsas digitadas pelo usuário.
 */
async function reescreverComInfo(req, res, next) {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (matter.status === 'publicado') {
      return res.status(400).json({
        error: 'Matéria já publicada. Gere uma nova se precisar reescrever o texto.',
      });
    }

    const infoExtra = String(req.body?.infoExtra || req.body?.info || req.body?.texto || '').trim();
    if (!infoExtra) {
      return res.status(400).json({ error: 'Cole as informações extras no campo antes de reescrever.' });
    }

    const deepseekService = require('../services/deepseekService');
    deepseekService.assertDeepseek();

    let hashtags = [];
    try {
      hashtags = Array.isArray(matter.hashtags)
        ? matter.hashtags
        : JSON.parse(matter.hashtags || '[]');
    } catch {
      hashtags = [];
    }

    const materiaAtual = String(req.body?.materia || matter.materia || '').trim();
    const tituloAtual = String(req.body?.titulo || matter.titulo || '').trim();

    const reescrito = await deepseekService.reescreverMateriaComInfo({
      titulo: tituloAtual,
      materia: materiaAtual,
      infoExtra,
      hashtags,
      fonteTitulo: matter.fonte_titulo,
    });

    const patch = {
      titulo: reescrito.titulo,
      materia: reescrito.materia,
      titulo_ia: reescrito.titulo,
      materia_ia: reescrito.materia,
      hashtags: JSON.stringify(reescrito.hashtags || []),
      error_message: null,
    };
    if (matter.status !== 'agendado') patch.status = 'rascunho';
    await AiMatters.update(matterId, patch);

    let updated = await AiMatters.findById(matterId);
    let imagemUrl = updated.imagem_url || null;
    let videoUrl = null;
    let aviso = 'Texto reescrito com as informações incluídas ✓';

    // Atualiza arte/capa se o título mudou
    const titleChanged =
      String(reescrito.titulo || '').trim() !== String(matter.titulo || '').trim();

    if (titleChanged && updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
      try {
        const { applyCoverToClipNow } = require('../services/clipPostProcessService');
        await applyCoverToClipNow({
          clipId: updated.video_clip_id,
          userId: req.session.userId,
          titulo: reescrito.titulo,
          force: true,
        });
        updated = await AiMatters.findById(matterId);
        if (updated.video_path) {
          videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
        }
        aviso = 'Texto reescrito e capa do Reel atualizada ✓';
      } catch (err) {
        aviso = `Texto reescrito, mas a capa do Reel não foi regenerada: ${err.message}`;
      }
    } else if (titleChanged) {
      const sourceUrl =
        updated.imagem_fonte_url ||
        (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
          ? updated.imagem_url
          : null);
      if (sourceUrl) {
        try {
          const artwork = await composeMatterArtwork({
            userId: req.session.userId,
            matterId: updated.id,
            sourceUrl,
            title: reescrito.titulo,
            force: true,
          });
          updated = artwork.matter;
          imagemUrl = artwork.publicUrl;
          aviso = 'Texto reescrito e arte atualizada ✓';
        } catch (err) {
          aviso = `Texto reescrito, mas a arte não foi regenerada: ${err.message}`;
        }
      }
    }

    return res.json({
      ok: true,
      titulo: reescrito.titulo,
      materia: reescrito.materia,
      hashtags: reescrito.hashtags,
      matter: updated,
      imagemUrl,
      videoUrl,
      aviso,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = {
  pesquisar,
  emAlta,
  gerar,
  reescreverLink,
  gerarPreview,
  gerarLote,
  publicar,
  listarMaterias,
  obterMateria,
  removerMateria,
  atualizarMateria,
  sugerirTitulo,
  reescreverComInfo,
  buscarImagemFonte,
  sugerirImagens,
  aplicarImagemUrl,
  showMatter,
  listPage,
  showLotePage,
  listMinhasMaterias,
  agendar,
  monitorCriar,
  monitorLista,
  monitorPausar,
  monitorRetomar,
};
