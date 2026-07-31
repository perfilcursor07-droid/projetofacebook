const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const Users = require('../models/Users');
const { enqueue } = require('../workers/queue');
const { storageAbsolutePath } = require('./downloadService');
const { extractFrame, renderSplitScreen, overlayTextoFixo, probe } = require('./ffmpegService');
const {
  DEFAULT_VIDEO_BRAND_MODEL,
  normalizeVideoBrandModel,
  videoBrandModelMeta,
} = require('./videoBrandModels');

const SPLIT_DIR = 'splits';
const FRAME_DIR = 'splits/frames';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXTO = 280;

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

function normalizarTextoSplit(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXTO);
}

function normalizarPosicaoTexto(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'topo' || v === 'meio') return v;
  return 'rodape';
}

function yBlocoTexto(posicao, h, blockH, padTopo = 0, padRodape = 0) {
  if (posicao === 'topo') return padTopo;
  if (posicao === 'meio') return Math.max(0, Math.round((h - blockH) / 2));
  return Math.max(0, h - blockH - padRodape);
}

/** Escala da fonte: 70–160 (% do tamanho padrão do modelo). */
function normalizarTamanhoTexto(raw, fallback = 100) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(160, Math.max(70, Math.round(n)));
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Tokens: texto normal e destaques marcados com [[palavra]]. */
function parseTokensComDestaque(texto) {
  const raw = String(texto || '');
  const tokens = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m.index > last) {
      tokens.push({ text: raw.slice(last, m.index), highlight: false });
    }
    tokens.push({ text: m[1], highlight: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) tokens.push({ text: raw.slice(last), highlight: false });
  return tokens
    .map((t) => ({ ...t, text: t.text.replace(/\s+/g, ' ') }))
    .filter((t) => t.text.length);
}

function textoSemMarcadores(texto) {
  return String(texto || '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimarLarguraChars(str, fontSize) {
  // Arial Black caixa-alta: um pouco mais largo que 0.62 — evita texto “estourar” a margem.
  return String(str || '').length * fontSize * 0.68;
}

/** Quebra tokens em linhas sem partir um destaque no meio. */
function quebrarTokensEmLinhas(tokens, maxWidthPx, fontSize, maxLinhas = 5) {
  const linhas = [];
  let atual = [];
  let atualW = 0;
  const spaceW = estimarLarguraChars(' ', fontSize);

  function flush() {
    if (atual.length) linhas.push(atual);
    atual = [];
    atualW = 0;
  }

  for (const token of tokens) {
    const partes = String(token.text)
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => ({ text: p.toUpperCase(), highlight: token.highlight }));

    for (const parte of partes) {
      const wordW = estimarLarguraChars(parte.text, fontSize);
      const need = atual.length ? atualW + spaceW + wordW : wordW;
      if (atual.length && need > maxWidthPx) {
        flush();
        if (linhas.length >= maxLinhas) return linhas;
      }
      if (!atual.length && wordW > maxWidthPx) {
        const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontSize * 0.68)));
        atual.push({ text: `${parte.text.slice(0, maxChars - 1)}…`, highlight: parte.highlight });
        flush();
        if (linhas.length >= maxLinhas) return linhas;
        continue;
      }
      atual.push(parte);
      atualW = atual.length === 1 ? wordW : atualW + spaceW + wordW;
    }
  }
  flush();
  return linhas.length ? linhas : [[{ text: '', highlight: false }]];
}

function normalizarFundoTexto(raw) {
  return String(raw || '').toLowerCase() === 'transparente' ? 'transparente' : 'cor';
}

function normalizarCorHex(raw, fallback = '#000000') {
  const v = String(raw || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : fallback;
}

function svgLinhaComDestaques({
  segmentos,
  y,
  startX,
  fontSize,
  highlightColor,
  align,
  totalWidth,
  minX = 0,
  maxX = Infinity,
}) {
  const spaceW = estimarLarguraChars(' ', fontSize);
  const padX = Math.round(fontSize * 0.18);
  const padY = Math.round(fontSize * 0.12);
  const boxH = Math.round(fontSize * 1.12);
  const boxY = y - fontSize + padY;

  let lineW = 0;
  segmentos.forEach((s, i) => {
    lineW += estimarLarguraChars(s.text, fontSize);
    if (i < segmentos.length - 1) lineW += spaceW;
  });

  let cursor = startX;
  if (align === 'center') {
    cursor = startX + Math.max(0, (totalWidth - lineW) / 2);
  }
  // Nunca começa antes da margem segura (evita corte na esquerda).
  cursor = Math.max(minX + padX, cursor);

  const parts = [];
  segmentos.forEach((seg, i) => {
    const segW = estimarLarguraChars(seg.text, fontSize);
    if (seg.highlight) {
      const boxX = Math.max(minX, cursor - padX);
      const boxW = Math.min(segW + padX * 2, maxX - boxX);
      parts.push(
        `<rect x="${boxX}" y="${boxY}" width="${Math.max(4, boxW)}" height="${boxH}" rx="3" fill="${escapeXml(highlightColor)}"/>`
      );
      parts.push(
        `<text x="${cursor}" y="${y}" fill="#0f172a" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900">${escapeXml(seg.text)}</text>`
      );
    } else {
      parts.push(
        `<text x="${cursor}" y="${y}" fill="#ffffff" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" stroke="#000" stroke-width="${Math.max(2, Math.round(fontSize * 0.06))}" paint-order="stroke fill">${escapeXml(seg.text)}</text>`
      );
    }
    cursor += segW + (i < segmentos.length - 1 ? spaceW : 0);
  });
  return parts.join('\n');
}

/**
 * Gera PNG do tamanho do vídeo com texto centralizado e margens seguras
 * (igual ao preview da tela dividida — sem colar na borda esquerda).
 */
async function criarFaixaTextoPng({
  texto,
  posicao,
  width,
  height,
  destAbs,
  modelo = DEFAULT_VIDEO_BRAND_MODEL,
  corDestaque = '#facc15',
  tamanhoPct = 100,
  fundo = 'cor',
  fundoCor = '#000000',
}) {
  const w = Math.max(320, Math.round(Number(width) || 1080));
  const h = Math.max(320, Math.round(Number(height) || 1920));
  const modeloId = normalizeVideoBrandModel(modelo);
  const scale = normalizarTamanhoTexto(tamanhoPct) / 100;
  const highlight = /^#[0-9a-f]{6}$/i.test(String(corDestaque || ''))
    ? String(corDestaque).toLowerCase()
    : '#facc15';
  const fundoModo = normalizarFundoTexto(fundo);
  const fundoHex = normalizarCorHex(fundoCor, '#000000');
  const tokens = parseTokensComDestaque(texto);

  // Fonte um pouco maior no viral; layout sempre full-width centralizado (como o preview).
  const baseRatio =
    modeloId === 'destaque_viral' ? 0.048 : modeloId === 'impacto_central' ? 0.046 : 0.042;
  const fontSize = Math.round(w * baseRatio * scale);
  const lineH = Math.round(fontSize * 1.28);
  const marginX = Math.max(36, Math.round(w * 0.06));
  const maxW = w - marginX * 2;
  const linhas = quebrarTokensEmLinhas(tokens, maxW, fontSize, 6);
  const padY = Math.round(w * 0.028);
  const blockH = padY * 2 + Math.max(1, linhas.length) * lineH;
  const barY = yBlocoTexto(
    posicao,
    h,
    blockH,
    posicao === 'topo' ? Math.round(h * 0.02) : 0,
    posicao === 'rodape' ? Math.round(h * 0.02) : 0
  );
  const baseY = barY + padY + fontSize;

  let fundoSvg = '';
  if (fundoModo === 'cor') {
    const opacity = posicao === 'meio' ? 0.78 : 0.82;
    if (posicao === 'meio' || modeloId === 'impacto_central') {
      const inset = Math.round(w * 0.035);
      fundoSvg = `<rect x="${inset}" y="${barY}" width="${w - inset * 2}" height="${blockH}" rx="14" fill="${escapeXml(fundoHex)}" fill-opacity="${opacity}"/>`;
    } else {
      fundoSvg = `<defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${escapeXml(fundoHex)}" stop-opacity="${posicao === 'topo' ? opacity : opacity * 0.7}"/>
      <stop offset="100%" stop-color="${escapeXml(fundoHex)}" stop-opacity="${posicao === 'topo' ? opacity * 0.7 : opacity}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${barY}" width="${w}" height="${blockH}" fill="url(#bar)"/>`;
    }
  }

  const linesSvg = linhas
    .map((segs, i) =>
      svgLinhaComDestaques({
        segmentos: segs,
        y: baseY + i * lineH,
        startX: marginX,
        fontSize,
        highlightColor: highlight,
        align: 'center',
        totalWidth: maxW,
        minX: marginX,
        maxX: w - marginX,
      })
    )
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
${fundoSvg}
${linesSvg}
</svg>`;

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(destAbs);
  return destAbs;
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
 * Texto opcional é queimado no corpo do vídeo (aparece depois da capa).
 */
async function aplicarSplitAgora({
  clipId,
  userId,
  imagemRelPath,
  videoOffset,
  imageOffset,
  imagemLado,
  texto,
  textoPosicao,
  textoTamanho,
  textoFundo,
  textoFundoCor,
}) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);

  const base = baseClipFile(clip);
  if (!base) throw httpError('Corte sem arquivo — gere o corte novamente.', 422);

  const imagemAbs = storageAbs(imagemRelPath);
  if (!fs.existsSync(imagemAbs)) throw httpError('Imagem da tela dividida não encontrada.', 422);

  const textoFinal = normalizarTextoSplit(
    texto != null ? texto : clip.split_texto
  );

  let videoModelo = DEFAULT_VIDEO_BRAND_MODEL;
  let videoCorDestaque = '#facc15';
  try {
    const user = await Users.findById(userId);
    if (user) {
      videoModelo = normalizeVideoBrandModel(user.marca_video_modelo);
      const cor = String(user.marca_video_cor_destaque || '').trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(cor)) videoCorDestaque = cor;
    }
  } catch {
    /* usa defaults */
  }

  const posicaoFinal = normalizarPosicaoTexto(
    textoPosicao != null
      ? textoPosicao
      : clip.split_texto_posicao || videoBrandModelMeta(videoModelo).posicaoPadrao
  );
  const tamanhoFinal = normalizarTamanhoTexto(
    textoTamanho != null ? textoTamanho : clip.split_texto_tamanho,
    100
  );
  const fundoFinal = normalizarFundoTexto(
    textoFundo != null ? textoFundo : clip.split_texto_fundo
  );
  const fundoCorFinal = normalizarCorHex(
    textoFundoCor != null ? textoFundoCor : clip.split_texto_fundo_cor,
    '#000000'
  );

  const uid = crypto.randomBytes(3).toString('hex');
  const splitTempRel = `clips/clip_${clip.id}_split_raw_${Date.now()}_${uid}.mp4`;
  const outRelative = `clips/clip_${clip.id}_split_${Date.now()}.mp4`;
  const splitTempAbs = storageAbs(splitTempRel);
  const outAbs = storageAbs(outRelative);
  const overlayAbs = storageAbs(`${SPLIT_DIR}/clip_${clip.id}_txt_${uid}.png`);
  const capaEstavaPronta = clip.capa_status === 'pronta';
  const arquivoAnterior = clip.caminho_arquivo;

  try {
    await renderSplitScreen({
      videoPath: storageAbs(base),
      imagePath: imagemAbs,
      outputPath: textoFinal ? splitTempAbs : outAbs,
      videoOffset,
      imageOffset,
      aspectRatio: clip.aspect_ratio === '1:1' ? '1:1' : '9:16',
      imagemLado,
    });

    if (textoFinal) {
      const info = await probe(splitTempAbs);
      const stream = (info.streams || []).find((s) => s.codec_type === 'video') || {};
      const width = Number(stream.width) || 1080;
      const height = Number(stream.height) || 1920;
      await criarFaixaTextoPng({
        texto: textoFinal,
        posicao: posicaoFinal,
        width,
        height,
        destAbs: overlayAbs,
        modelo: videoModelo,
        corDestaque: videoCorDestaque,
        tamanhoPct: tamanhoFinal,
        fundo: fundoFinal,
        fundoCor: fundoCorFinal,
      });
      await overlayTextoFixo({
        videoPath: splitTempAbs,
        overlayPath: overlayAbs,
        outputPath: outAbs,
      });
      safeUnlink(splitTempRel);
    }

    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 1000) {
      throw new Error('arquivo final vazio');
    }

    // A capa passa a ser gerada sobre a versão em tela dividida (+ texto).
    // O texto fica no corpo do Reel — a capa intro fica sem ele.
    await VideoClips.update(clip.id, {
      caminho_arquivo: outRelative,
      arquivo_sem_split: base,
      arquivo_sem_capa: outRelative,
      layout: 'split',
      split_status: 'pronta',
      split_image_path: imagemRelPath,
      split_video_offset: clampOffset(videoOffset),
      split_image_offset: clampOffset(imageOffset),
      split_texto: textoFinal || null,
      split_texto_posicao: posicaoFinal,
      split_texto_tamanho: tamanhoFinal,
      split_texto_fundo: fundoFinal,
      split_texto_fundo_cor: fundoCorFinal,
      split_erro: null,
      capa_status: capaEstavaPronta ? 'gerando' : 'pendente',
    });

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
    safeUnlink(splitTempRel);
    await VideoClips.update(clip.id, {
      split_status: 'erro',
      split_erro: `Tela dividida falhou: ${String(err.message || err).slice(0, 320)}`,
    });
    throw err;
  } finally {
    try {
      if (fs.existsSync(overlayAbs)) fs.unlinkSync(overlayAbs);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Enfileira a tela dividida do corte.
 * @returns {Promise<{ queued: true, imagem: string }>}
 */
async function aplicarSplitNoClip({
  clipId,
  userId,
  fonte,
  imagemUrl,
  buffer,
  frameSegundo,
  videoOffset,
  imageOffset,
  imagemLado,
  texto,
  textoPosicao,
  textoTamanho,
  textoFundo,
  textoFundoCor,
}) {
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
  const textoFinal = normalizarTextoSplit(texto != null ? texto : clip.split_texto);
  const posicaoFinal = normalizarPosicaoTexto(
    textoPosicao != null ? textoPosicao : clip.split_texto_posicao
  );
  const tamanhoFinal = normalizarTamanhoTexto(
    textoTamanho != null ? textoTamanho : clip.split_texto_tamanho,
    100
  );
  const fundoFinal = normalizarFundoTexto(
    textoFundo != null ? textoFundo : clip.split_texto_fundo
  );
  const fundoCorFinal = normalizarCorHex(
    textoFundoCor != null ? textoFundoCor : clip.split_texto_fundo_cor,
    '#000000'
  );

  await VideoClips.update(clip.id, {
    split_status: 'gerando',
    split_erro: null,
    split_image_origem: imagem.origem,
    split_image_url: imagem.url,
    split_video_offset: offsets.videoOffset,
    split_image_offset: offsets.imageOffset,
    split_texto: textoFinal || null,
    split_texto_posicao: posicaoFinal,
    split_texto_tamanho: tamanhoFinal,
    split_texto_fundo: fundoFinal,
    split_texto_fundo_cor: fundoCorFinal,
  });

  enqueue(`split clip ${clip.id}`, async () => {
    try {
      await aplicarSplitAgora({
        clipId: clip.id,
        userId,
        imagemRelPath: imagem.relativePath,
        imagemLado: lado,
        texto: textoFinal,
        textoPosicao: posicaoFinal,
        textoTamanho: tamanhoFinal,
        textoFundo: fundoFinal,
        textoFundoCor: fundoCorFinal,
        ...offsets,
      });
    } catch (err) {
      console.error(`[split] clip ${clip.id}:`, err.message || err);
    }
  });

  return {
    queued: true,
    imagem: `/media/${imagem.relativePath}`,
    texto: textoFinal || null,
    texto_posicao: posicaoFinal,
    texto_tamanho: tamanhoFinal,
    texto_fundo: fundoFinal,
    texto_fundo_cor: fundoCorFinal,
    ...offsets,
  };
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
    split_texto: null,
    split_texto_posicao: 'rodape',
    split_erro: null,
    capa_status: capaEstavaPronta ? 'gerando' : 'pendente',
  });

  if (anterior && anterior !== base) safeUnlink(anterior);
  if (clip.split_image_path) safeUnlink(clip.split_image_path);

  await regenerarCapaSePreciso(clip.id, userId, capaEstavaPronta, clip.capa_titulo);
  return { ok: true };
}

/** Reaplica a tela dividida com a mesma imagem, só mudando o enquadramento/texto. */
async function reenquadrarSplit({
  clipId,
  userId,
  videoOffset,
  imageOffset,
  imagemLado,
  texto,
  textoPosicao,
  textoTamanho,
  textoFundo,
  textoFundoCor,
}) {
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
  const textoFinal = normalizarTextoSplit(texto != null ? texto : clip.split_texto);
  const posicaoFinal = normalizarPosicaoTexto(
    textoPosicao != null ? textoPosicao : clip.split_texto_posicao
  );
  const tamanhoFinal = normalizarTamanhoTexto(
    textoTamanho != null ? textoTamanho : clip.split_texto_tamanho,
    100
  );
  const fundoFinal = normalizarFundoTexto(
    textoFundo != null ? textoFundo : clip.split_texto_fundo
  );
  const fundoCorFinal = normalizarCorHex(
    textoFundoCor != null ? textoFundoCor : clip.split_texto_fundo_cor,
    '#000000'
  );

  await VideoClips.update(clip.id, {
    split_status: 'gerando',
    split_erro: null,
    split_texto: textoFinal || null,
    split_texto_posicao: posicaoFinal,
    split_texto_tamanho: tamanhoFinal,
    split_texto_fundo: fundoFinal,
    split_texto_fundo_cor: fundoCorFinal,
  });

  enqueue(`split clip ${clip.id}`, async () => {
    try {
      await aplicarSplitAgora({
        clipId: clip.id,
        userId,
        imagemRelPath: clip.split_image_path,
        imagemLado: lado,
        texto: textoFinal,
        textoPosicao: posicaoFinal,
        textoTamanho: tamanhoFinal,
        textoFundo: fundoFinal,
        textoFundoCor: fundoCorFinal,
        ...offsets,
      });
    } catch (err) {
      console.error(`[split] reenquadrar clip ${clip.id}:`, err.message || err);
    }
  });

  return {
    queued: true,
    texto: textoFinal || null,
    texto_posicao: posicaoFinal,
    texto_tamanho: tamanhoFinal,
    texto_fundo: fundoFinal,
    texto_fundo_cor: fundoCorFinal,
    ...offsets,
  };
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
