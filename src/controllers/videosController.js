const path = require('path');
const pexelsService = require('../services/pexelsService');
const importService = require('../services/importService');
const Videos = require('../models/Videos');
const VideoClips = require('../models/VideoClips');
const processingService = require('../services/processingService');
const deepseekService = require('../services/deepseekService');
const { MAX_CLIP_SECONDS, MAX_MANUAL_CLIP_SECONDS, MIN_CLIP_SECONDS, probe } = require('../services/ffmpegService');
const { storageAbsolutePath } = require('../services/downloadService');

/** Registra um vídeo enviado por upload (já está no disco via multer). */
async function upload(req, res, next) {
  try {
    if (!req.file) {
      const err = new Error('Nenhum arquivo enviado (campo "arquivo")');
      err.status = 400;
      throw err;
    }

    const relativePath = `videos/${req.file.filename}`;
    let duracao = null;
    try {
      const info = await probe(storageAbsolutePath(relativePath));
      duracao = info?.format?.duration ? Math.round(info.format.duration) : null;
    } catch {
      // duração fica nula se o probe falhar; corte ainda é possível
    }

    const [id] = await Videos.create({
      user_id: req.session.userId,
      origem: 'upload',
      termo_busca: 'upload',
      titulo: path.parse(req.file.originalname).name,
      duracao,
      status: 'baixado',
      caminho_local: relativePath,
      metadata: { nome_original: req.file.originalname, tamanho: req.file.size },
    });

    const video = await Videos.findById(id);
    res.status(201).json({ video, created: true });
  } catch (err) {
    next(err);
  }
}

/** Importa vídeo por link (YouTube, TikTok, URL direta) via yt-dlp. */
async function importLink(req, res, next) {
  try {
    const url = String(req.body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      const err = new Error('Informe uma URL válida (http/https)');
      err.status = 400;
      throw err;
    }

    const existing = await Videos.findByUrl(req.session.userId, url);
    if (existing) {
      return res.json({ video: existing, created: false, queued: existing.status === 'pendente' });
    }

    let meta = {};
    let metaWarning = null;
    try {
      meta = await importService.fetchLinkMetadata(url);
    } catch (metaErr) {
      // Em VPS o YouTube às vezes bloqueia só a leitura de metadados —
      // ainda assim enfileira o download e deixa a Fila tentar.
      metaWarning = importService.humanizeYtDlpError(metaErr);
      console.warn('[import] metadata falhou, enfileirando mesmo assim:', metaWarning);
      meta = {
        titulo: req.body.titulo || null,
        thumbnail: req.body.thumbnail || null,
        extractor: null,
        autor: null,
        autorUrl: null,
        duracao: null,
      };
    }

    const [id] = await Videos.create({
      user_id: req.session.userId,
      origem: 'link',
      termo_busca: (req.body.termo || meta.extractor || 'link').toString().slice(0, 255),
      titulo: meta.titulo || req.body.titulo || url.slice(0, 120),
      url_original: url,
      thumbnail: meta.thumbnail || req.body.thumbnail || null,
      duracao: meta.duracao,
      autor: meta.autor,
      autor_url: meta.autorUrl,
      status: 'pendente',
      metadata: { extractor: meta.extractor, fonte: req.body.fonte || null, metaWarning },
    });

    const video = await Videos.findById(id);
    importService.queueLinkImport(video);

    res.status(202).json({
      video,
      queued: true,
      created: true,
      aviso: metaWarning
        ? `Link enfileirado, mas a prévia falhou: ${metaWarning}`
        : null,
    });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.session.userId;
    if (!userId) {
      const err = new Error('Usuário não autenticado');
      err.status = 401;
      throw err;
    }

    const videos = await Videos.findByUser(userId, {
      status: req.query.status || undefined,
    });

    const ids = videos.map((v) => v.id);
    const clips = ids.length ? await VideoClips.findByVideoIds(ids) : [];
    const clipsByVideo = {};
    for (const clip of clips) {
      (clipsByVideo[clip.video_id] = clipsByVideo[clip.video_id] || []).push(clip);
    }

    res.json({
      videos: videos.map((v) => ({ ...v, clips: clipsByVideo[v.id] || [] })),
    });
  } catch (err) {
    next(err);
  }
}

/** Enfileira o download do arquivo HD do vídeo. */
async function download(req, res, next) {
  try {
    const video = await Videos.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Vídeo não encontrado');
      err.status = 404;
      throw err;
    }
    if (video.status === 'baixado' || video.status === 'cortado') {
      return res.json({ video, queued: false, message: 'Vídeo já baixado' });
    }
    if (!video.url_original) {
      const err = new Error('Vídeo sem URL de origem para baixar');
      err.status = 422;
      throw err;
    }

    if (video.origem === 'link') {
      importService.queueLinkImport(video);
    } else {
      processingService.queueVideoDownload(video);
    }
    res.status(202).json({ queued: true, message: 'Download enfileirado' });
  } catch (err) {
    next(err);
  }
}

/** Cria um corte (inicio/fim/formato) e enfileira a geração via ffmpeg. */
async function clip(req, res, next) {
  try {
    const video = await Videos.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Vídeo não encontrado');
      err.status = 404;
      throw err;
    }
    if (!video.caminho_local) {
      const err = new Error('Baixe o vídeo antes de gerar cortes');
      err.status = 422;
      throw err;
    }

    const inicio = Number(req.body.inicio);
    const fim = Number(req.body.fim);
    const aspectRatio = ['9:16', '1:1', 'original'].includes(req.body.aspect_ratio)
      ? req.body.aspect_ratio
      : '9:16';

    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) {
      const err = new Error('Informe início e fim válidos (fim > início)');
      err.status = 400;
      throw err;
    }
    const duracaoCorte = fim - inicio;
    if (duracaoCorte > MAX_MANUAL_CLIP_SECONDS) {
      const err = new Error(`Corte máximo de ${MAX_MANUAL_CLIP_SECONDS} segundos (30 min)`);
      err.status = 400;
      throw err;
    }
    if (duracaoCorte < MIN_CLIP_SECONDS) {
      const err = new Error(`Corte mínimo de ${MIN_CLIP_SECONDS} segundos (exigência do Facebook Reels)`);
      err.status = 400;
      throw err;
    }
    if (video.duracao && inicio >= video.duracao) {
      const err = new Error(`Início além da duração do vídeo (${video.duracao}s)`);
      err.status = 400;
      throw err;
    }
    if (video.duracao && fim > video.duracao + 1) {
      const err = new Error(`Fim além da duração do vídeo (${video.duracao}s)`);
      err.status = 400;
      throw err;
    }

    const [clipId] = await VideoClips.create({
      video_id: video.id,
      inicio_segundo: inicio,
      fim_segundo: fim,
      aspect_ratio: aspectRatio,
      legenda_sugerida: req.body.legenda || null,
      status: 'processando',
    });

    const created = await VideoClips.findById(clipId);
    processingService.queueClipGeneration(created, video);

    res.status(202).json({
      clip: created,
      queued: true,
      aviso:
        duracaoCorte > MAX_CLIP_SECONDS
          ? `Corte de ${Math.round(duracaoCorte)}s — acima de ${MAX_CLIP_SECONDS}s: publique como Vídeo (não Reel)`
          : undefined,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Analisa o vídeo com IA (Whisper + DeepSeek) e sugere/gera os melhores cortes.
 * Body: { aspect_ratio?, max_cortes?, gerar? }
 */
async function analyze(req, res, next) {
  try {
    const video = await Videos.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Vídeo não encontrado');
      err.status = 404;
      throw err;
    }
    if (!video.caminho_local) {
      const err = new Error('Baixe o vídeo antes de analisar os cortes');
      err.status = 422;
      throw err;
    }

    deepseekService.assertDeepseek();

    const meta = typeof video.metadata === 'string'
      ? (() => { try { return JSON.parse(video.metadata); } catch { return {}; } })()
      : (video.metadata || {});

    if (meta.analise_status === 'processando') {
      return res.status(202).json({
        queued: true,
        message: 'Análise IA já em andamento — aguarde e atualize a fila',
      });
    }

    processingService.queueVideoAnalyze(video, {
      aspectRatio: req.body.aspect_ratio,
      maxCortes: req.body.max_cortes || req.body.maxCortes || 3,
      gerar: req.body.gerar !== false && req.body.gerar !== 0 && req.body.gerar !== '0',
    });

    res.status(202).json({
      queued: true,
      message:
        'IA analisando a fala para criar momentos completos de 40–90s. Os melhores cortes aparecerão na fila em instantes.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Gera cortes automáticos de até 90s cobrindo o vídeo inteiro
 * (0-90, 90-180, …). Trechos finais com menos de 3s são descartados.
 */
async function clipAuto(req, res, next) {
  try {
    const video = await Videos.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Vídeo não encontrado');
      err.status = 404;
      throw err;
    }
    if (!video.caminho_local) {
      const err = new Error('Baixe o vídeo antes de gerar cortes');
      err.status = 422;
      throw err;
    }

    const duracao = Number(video.duracao);
    if (!Number.isFinite(duracao) || duracao < MIN_CLIP_SECONDS) {
      const err = new Error('Duração do vídeo inválida ou menor que 3 segundos');
      err.status = 422;
      throw err;
    }

    const aspectRatio = ['9:16', '1:1', 'original'].includes(req.body.aspect_ratio)
      ? req.body.aspect_ratio
      : '9:16';
    const step = Math.min(
      MAX_CLIP_SECONDS,
      Math.max(MIN_CLIP_SECONDS, Number(req.body.intervalo) || MAX_CLIP_SECONDS)
    );

    const ranges = [];
    for (let start = 0; start < duracao; start += step) {
      const end = Math.min(duracao, start + step);
      if (end - start < MIN_CLIP_SECONDS) break;
      ranges.push({ inicio: start, fim: end });
    }

    if (!ranges.length) {
      const err = new Error('Não foi possível montar cortes de pelo menos 3 segundos');
      err.status = 422;
      throw err;
    }

    // Limite de segurança para vídeos longos (ex.: 3536s ≈ 40 cortes de 90s)
    const MAX_AUTO_CLIPS = 60;
    const selected = ranges.slice(0, MAX_AUTO_CLIPS);

    const createdClips = [];
    for (const range of selected) {
      const [clipId] = await VideoClips.create({
        video_id: video.id,
        inicio_segundo: range.inicio,
        fim_segundo: range.fim,
        aspect_ratio: aspectRatio,
        status: 'processando',
      });
      const created = await VideoClips.findById(clipId);
      processingService.queueClipGeneration(created, video);
      createdClips.push(created);
    }

    res.status(202).json({
      queued: true,
      total: createdClips.length,
      truncado: ranges.length > MAX_AUTO_CLIPS,
      intervalo: step,
      clips: createdClips,
    });
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const termo = req.query.termo || req.query.q || '';
    const page = req.query.page;
    const perPage = req.query.per_page || req.query.perPage;
    const fonte = String(req.query.fonte || 'pexels').toLowerCase();

    if (fonte === 'youtube') {
      const maxDurationRaw = req.query.max_duration ?? req.query.maxDuration;
      const maxDuration =
        maxDurationRaw === 'all' || maxDurationRaw === ''
          ? null
          : maxDurationRaw != null
            ? Number(maxDurationRaw)
            : 180;
      const shortsOnly =
        req.query.shorts_only === '1' ||
        req.query.shortsOnly === '1' ||
        req.query.filtro === 'shorts';

      const result = await importService.searchYoutube(termo, {
        limit: perPage || 100,
        maxDuration: shortsOnly ? 60 : maxDuration,
        shortsOnly,
      });
      return res.json(result);
    }

    if (fonte === 'tiktok') {
      const result = await importService.searchTiktok(termo, {
        limit: perPage || 60,
      });
      return res.json(result);
    }

    const result = await pexelsService.searchVideos(termo, { page, perPage });
    res.json({ ...result, fonte: 'pexels' });
  } catch (err) {
    if (err.status) return next(err);
    if (err.response?.status === 401 || err.response?.status === 403) {
      err.status = 502;
      err.message = 'Falha de autenticação na Pexels. Verifique PEXELS_API_KEY.';
    } else if (err.response?.status === 429) {
      err.status = 429;
      err.message = 'Rate limit da Pexels atingido. Tente novamente em alguns minutos.';
    } else if (err.response) {
      err.status = 502;
      err.message = err.response.data?.error || 'Erro ao consultar a Pexels API';
    } else if (err.stderr || /yt-dlp|youtube/i.test(err.message || '')) {
      err.status = 502;
      err.message = `Falha na busca: ${String(err.stderr || err.message).slice(0, 300)}`;
    }
    next(err);
  }
}

/**
 * Registra o vídeo no banco (status pendente) a partir do ID Pexels.
 * Download real fica para a etapa 3.
 */
async function selectVideo(req, res, next) {
  try {
    const pexelsId = req.params.pexelsId;
    const termo = (req.body.termo || req.query.termo || '').trim() || 'sem termo';
    const userId = req.session.userId;

    if (!userId) {
      const err = new Error('Usuário não autenticado');
      err.status = 401;
      throw err;
    }

    const existing = await Videos.findByPexelsId(userId, pexelsId);
    if (existing) {
      return res.json({ video: existing, created: false });
    }

    const remote = await pexelsService.getVideoById(pexelsId);
    if (!remote.urlOriginal) {
      const err = new Error('Vídeo sem arquivo MP4 disponível');
      err.status = 422;
      throw err;
    }

    const [id] = await Videos.create({
      user_id: userId,
      termo_busca: termo,
      pexels_id: remote.pexelsId,
      url_original: remote.urlOriginal,
      thumbnail: remote.thumbnail,
      duracao: remote.duracao,
      autor: remote.autor,
      autor_url: remote.autorUrl,
      status: 'pendente',
      metadata: {
        pexels_url: remote.url,
        qualidade: remote.qualidade,
        width: remote.width,
        height: remote.height,
        arquivoWidth: remote.arquivoWidth,
        arquivoHeight: remote.arquivoHeight,
      },
    });

    const video = await Videos.findById(id);
    res.status(201).json({ video, created: true });
  } catch (err) {
    if (err.response) {
      err.status = 502;
      err.message = 'Não foi possível obter o vídeo na Pexels';
    }
    next(err);
  }
}

/** Remove vídeo, cortes e arquivos locais. */
async function removeVideo(req, res, next) {
  try {
    const video = await Videos.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      const err = new Error('Vídeo não encontrado');
      err.status = 404;
      throw err;
    }

    const clips = await VideoClips.findByVideo(video.id);
    for (const clip of clips) {
      processingService.safeUnlink(clip.caminho_arquivo);
    }
    processingService.safeUnlink(video.caminho_local);
    await Videos.remove(video.id);

    res.json({ deleted: true, id: video.id, clipsRemovidos: clips.length });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  search,
  selectVideo,
  download,
  clip,
  clipAuto,
  analyze,
  upload,
  importLink,
  removeVideo,
};
