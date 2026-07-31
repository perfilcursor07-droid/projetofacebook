const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const { enqueue } = require('../workers/queue');
const { storageAbsolutePath } = require('./downloadService');
const { extractFrame, renderSplitScreen, probe } = require('./ffmpegService');

const SPLIT_DIR = 'splits';
const FRAME_DIR = 'splits/frames';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function storageAbs(relative) {
  return storageAbsolutePath(relative);
}

function safeUnlink(relative) {
  if (!relative) return;
  try {
    const abs = storageAbs(relative);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}

function clampOffset(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

/**
 * Arquivo base do corte, sem capa e sem tela dividida.
 * O ffmpeg do corte sempre grava em clips/clip_<id>.mp4, então esse é o original.
 */
function baseClipFile(clip) {
  const candidates = [
    `clips/clip_${clip.id}.mp4`,
    clip.arquivo_sem_split,
    clip.arquivo_sem_capa,
    clip.caminho_arquivo,
  ];
  for (const relative of candidates) {
    if (relative && fs.existsSync(storageAbs(relative))) return relative;
  }
  return null;
}

/** Normaliza qualquer imagem (png/webp/jpg) para um JPG pronto pro ffmpeg. */
async function normalizarImagem(buffer, destRelative) {
  const abs = storageAbs(destRelative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await sharp(buffer)
    .rotate()
    // Metade de 1080x1920 precisa de pouco: 1200x2400 cobre com folga.
    .resize({ width: 1200, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(abs);
  return destRelative;
}

async function baixarImagemRemota(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw httpError('URL de imagem inválida (use http/https)');
  }
  const { data, headers } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
    },
  });
  const contentType = String(headers?.['content-type'] || '');
  const buffer = Buffer.from(data);
  if (!buffer.length) throw httpError('A imagem escolhida veio vazia. Tente outra.', 422);
  if (contentType && !/^image\//i.test(contentType)) {
    throw httpError('O link escolhido não é uma imagem. Tente outra.', 422);
  }
  return buffer;
}

/**
 * Resolve a imagem da metade esquerda a partir da fonte escolhida pelo usuário.
 * @param {object} opts
 * @param {object} opts.clip
 * @param {'busca'|'upload'|'frame'} opts.fonte
 * @param {string} [opts.imagemUrl] usado em fonte "busca"
 * @param {Buffer} [opts.buffer] usado em fonte "upload"
 * @param {number} [opts.frameSegundo] usado em fonte "frame"
 * @returns {Promise<{ relativePath: string, origem: string, url: string|null }>}
 */
async function resolverImagemDoSplit({ clip, fonte, imagemUrl, buffer, frameSegundo }) {
  const uid = crypto.randomBytes(3).toString('hex');
  const dest = `${SPLIT_DIR}/clip_${clip.id}_img_${Date.now()}_${uid}.jpg`;

  if (fonte === 'upload') {
    if (!buffer?.length) throw httpError('Envie um arquivo de imagem.');
    await normalizarImagem(buffer, dest);
    return { relativePath: dest, origem: 'upload', url: null };
  }

  if (fonte === 'frame') {
    const base = baseClipFile(clip);
    if (!base) throw httpError('Corte sem arquivo — gere o corte novamente.', 422);
    const tempFrame = storageAbs(`${SPLIT_DIR}/tmp_frame_${clip.id}_${uid}.jpg`);
    try {
      await extractFrame(storageAbs(base), tempFrame, Number(frameSegundo) || 0.5);
      if (!fs.existsSync(tempFrame) || fs.statSync(tempFrame).size < 500) {
        throw httpError('Não foi possível pegar esse momento do vídeo. Escolha outro.', 422);
      }
      await normalizarImagem(fs.readFileSync(tempFrame), dest);
      return { relativePath: dest, origem: 'frame', url: null };
    } finally {
      try {
        if (fs.existsSync(tempFrame)) fs.unlinkSync(tempFrame);
      } catch {
        /* ignore */
      }
    }
  }

  const remote = await baixarImagemRemota(imagemUrl);
  await normalizarImagem(remote, dest);
  return {
    relativePath: dest,
    origem: 'busca',
    url: String(imagemUrl).slice(0, 1000),
  };
}

/**
 * Gera miniaturas ao longo do corte para o usuário usar um frame como imagem.
 * @returns {Promise<Array<{ segundo: number, url: string }>>}
 */
async function listarFramesDoClip(clip, quantidade = 6) {
  const base = baseClipFile(clip);
  if (!base) throw httpError('Corte sem arquivo — gere o corte novamente.', 422);

  let duracao = Number(clip.fim_segundo) - Number(clip.inicio_segundo);
  try {
    const info = await probe(storageAbs(base));
    const probed = Number(info?.format?.duration);
    if (Number.isFinite(probed) && probed > 0) duracao = probed;
  } catch {
    /* usa a duração do registro */
  }
  if (!Number.isFinite(duracao) || duracao <= 0) duracao = 10;

  const total = Math.min(12, Math.max(3, Number(quantidade) || 6));
  const frames = [];
  for (let i = 0; i < total; i += 1) {
    // Distribui os pontos evitando o primeiro e o último frame (costumam ser preto).
    const segundo = Math.max(0.3, (duracao * (i + 0.5)) / total);
    const relative = `${FRAME_DIR}/clip_${clip.id}_${Math.round(segundo * 10)}.jpg`;
    const abs = storageAbs(relative);
    try {
      if (!fs.existsSync(abs) || fs.statSync(abs).size < 500) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        await extractFrame(storageAbs(base), abs, segundo);
      }
      if (fs.existsSync(abs) && fs.statSync(abs).size > 500) {
        frames.push({ segundo: Number(segundo.toFixed(1)), url: `/media/${relative}` });
      }
    } catch {
      /* ignora frames que falharem */
    }
  }

  if (!frames.length) throw httpError('Não foi possível extrair frames deste corte.', 422);
  return frames;
}

/** Se o corte tinha capa pronta, refaz a capa sobre o novo arquivo. */
async function regenerarCapaSePreciso(clipId, userId, capaEstavaPronta, titulo) {
  if (!capaEstavaPronta || !userId) return;
  try {
    const { applyCoverToClipNow } = require('./clipPostProcessService');
    await applyCoverToClipNow({ clipId, userId, titulo: titulo || null, force: true });
  } catch (err) {
    console.warn(`[split] refazer capa clip #${clipId}:`, err.message || err);
  }
}

/**
 * Renderiza a tela dividida agora (roda dentro da fila).
 */
async function aplicarSplitAgora({ clipId, userId, imagemRelPath, videoOffset, imageOffset, imagemLado }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);

  const base = baseClipFile(clip);
  if (!base) throw httpError('Corte sem arquivo — gere o corte novamente.', 422);

  const imagemAbs = storageAbs(imagemRelPath);
  if (!fs.existsSync(imagemAbs)) throw httpError('Imagem da tela dividida não encontrada.', 422);

  const outRelative = `clips/clip_${clip.id}_split_${Date.now()}.mp4`;
  const outAbs = storageAbs(outRelative);
  const capaEstavaPronta = clip.capa_status === 'pronta';
  const arquivoAnterior = clip.caminho_arquivo;

  try {
    await renderSplitScreen({
      videoPath: storageAbs(base),
      imagePath: imagemAbs,
      outputPath: outAbs,
      videoOffset,
      imageOffset,
      aspectRatio: clip.aspect_ratio === '1:1' ? '1:1' : '9:16',
      imagemLado,
    });
    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 1000) {
      throw new Error('arquivo final vazio');
    }

    // A capa passa a ser gerada sobre a versão em tela dividida.
    await VideoClips.update(clip.id, {
      caminho_arquivo: outRelative,
      arquivo_sem_split: base,
      arquivo_sem_capa: outRelative,
      layout: 'split',
      split_status: 'pronta',
      split_image_path: imagemRelPath,
      split_video_offset: clampOffset(videoOffset),
      split_image_offset: clampOffset(imageOffset),
      split_erro: null,
      capa_status: capaEstavaPronta ? 'gerando' : 'pendente',
    });

    // Limpa o arquivo antigo (capa/split anterior), nunca o corte original.
    if (arquivoAnterior && arquivoAnterior !== base && arquivoAnterior !== outRelative) {
      safeUnlink(arquivoAnterior);
    }
    if (clip.split_image_path && clip.split_image_path !== imagemRelPath) {
      safeUnlink(clip.split_image_path);
    }

    await regenerarCapaSePreciso(clip.id, userId, capaEstavaPronta, clip.capa_titulo);
    return { relativePath: outRelative };
  } catch (err) {
    safeUnlink(outRelative);
    await VideoClips.update(clip.id, {
      split_status: 'erro',
      split_erro: `Tela dividida falhou: ${String(err.message || err).slice(0, 320)}`,
    });
    throw err;
  }
}

/**
 * Enfileira a tela dividida do corte.
 * @returns {Promise<{ queued: true, imagem: string }>}
 */
async function aplicarSplitNoClip({ clipId, userId, fonte, imagemUrl, buffer, frameSegundo, videoOffset, imageOffset, imagemLado }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (!['pronto', 'publicado'].includes(String(clip.status))) {
    throw httpError('Espere o corte ficar pronto antes de montar a tela dividida.', 422);
  }

  const fonteFinal = ['upload', 'frame'].includes(fonte) ? fonte : 'busca';
  const imagem = await resolverImagemDoSplit({
    clip,
    fonte: fonteFinal,
    imagemUrl,
    buffer,
    frameSegundo,
  });

  const offsets = {
    videoOffset: clampOffset(videoOffset, Number(clip.split_video_offset) || 50),
    imageOffset: clampOffset(imageOffset, Number(clip.split_image_offset) || 50),
  };
  const lado = imagemLado === 'direita' ? 'direita' : 'esquerda';

  await VideoClips.update(clip.id, {
    split_status: 'gerando',
    split_erro: null,
    split_image_origem: imagem.origem,
    split_image_url: imagem.url,
    split_video_offset: offsets.videoOffset,
    split_image_offset: offsets.imageOffset,
  });

  enqueue(`split clip ${clip.id}`, async () => {
    try {
      await aplicarSplitAgora({
        clipId: clip.id,
        userId,
        imagemRelPath: imagem.relativePath,
        imagemLado: lado,
        ...offsets,
      });
    } catch (err) {
      console.error(`[split] clip ${clip.id}:`, err.message || err);
    }
  });

  return { queued: true, imagem: `/media/${imagem.relativePath}`, ...offsets };
}

/** Volta o corte para o vídeo cheio (sem imagem ao lado). */
async function removerSplitDoClip({ clipId, userId }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (clip.layout !== 'split' && !clip.arquivo_sem_split) {
    throw httpError('Este corte não está em tela dividida.', 422);
  }

  const base = baseClipFile(clip);
  if (!base) throw httpError('Arquivo original do corte não existe mais — gere o corte novamente.', 422);

  const capaEstavaPronta = clip.capa_status === 'pronta';
  const anterior = clip.caminho_arquivo;

  await VideoClips.update(clip.id, {
    caminho_arquivo: base,
    arquivo_sem_split: null,
    arquivo_sem_capa: capaEstavaPronta ? base : null,
    layout: 'normal',
    split_status: 'pendente',
    split_image_path: null,
    split_image_origem: null,
    split_image_url: null,
    split_erro: null,
    capa_status: capaEstavaPronta ? 'gerando' : 'pendente',
  });

  if (anterior && anterior !== base) safeUnlink(anterior);
  if (clip.split_image_path) safeUnlink(clip.split_image_path);

  await regenerarCapaSePreciso(clip.id, userId, capaEstavaPronta, clip.capa_titulo);
  return { ok: true };
}

/** Reaplica a tela dividida com a mesma imagem, só mudando o enquadramento. */
async function reenquadrarSplit({ clipId, userId, videoOffset, imageOffset, imagemLado }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (!clip.split_image_path || !fs.existsSync(storageAbs(clip.split_image_path))) {
    throw httpError('Escolha a imagem da tela dividida primeiro.', 422);
  }

  const offsets = {
    videoOffset: clampOffset(videoOffset, Number(clip.split_video_offset) || 50),
    imageOffset: clampOffset(imageOffset, Number(clip.split_image_offset) || 50),
  };
  const lado = imagemLado === 'direita' ? 'direita' : 'esquerda';

  await VideoClips.update(clip.id, { split_status: 'gerando', split_erro: null });

  enqueue(`split clip ${clip.id}`, async () => {
    try {
      await aplicarSplitAgora({
        clipId: clip.id,
        userId,
        imagemRelPath: clip.split_image_path,
        imagemLado: lado,
        ...offsets,
      });
    } catch (err) {
      console.error(`[split] reenquadrar clip ${clip.id}:`, err.message || err);
    }
  });

  return { queued: true, ...offsets };
}

/** Vídeo usado nos previews e nos frames (sempre sem capa/split). */
function previewBaseUrl(clip) {
  const base = baseClipFile(clip);
  return base ? `/media/${base}` : null;
}

module.exports = {
  aplicarSplitNoClip,
  removerSplitDoClip,
  reenquadrarSplit,
  listarFramesDoClip,
  previewBaseUrl,
  baseClipFile,
};
