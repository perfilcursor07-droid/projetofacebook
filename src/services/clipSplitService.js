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
  return String(raw || '').toLowerCase() === 'topo' ? 'topo' : 'rodape';
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
  // Arial Black caixa-alta: ~0.62em por caractere (aprox. suficiente p/ SVG).
  return String(str || '').length * fontSize * 0.62;
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
      const w = estimarLarguraChars(parte.text, fontSize);
      const need = atual.length ? atualW + spaceW + w : w;
      if (atual.length && need > maxWidthPx) {
        flush();
        if (linhas.length >= maxLinhas) return linhas;
      }
      if (!atual.length && w > maxWidthPx) {
        // Palavra enorme: corta.
        const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontSize * 0.62)));
        atual.push({ text: `${parte.text.slice(0, maxChars - 1)}…`, highlight: parte.highlight });
        flush();
        if (linhas.length >= maxLinhas) return linhas;
        continue;
      }
      atual.push(parte);
      atualW = atual.length === 1 ? w : atualW + spaceW + w;
    }
  }
  flush();
  return linhas.length ? linhas : [[{ text: '', highlight: false }]];
}

/** Quebra texto simples (sem tokens) em linhas. */
function quebrarLinhas(texto, maxChars = 34, maxLinhas = 4) {
  const plain = textoSemMarcadores(texto).toUpperCase();
  const palavras = plain.split(/\s+/).filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const palavra of palavras) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (tentativa.length <= maxChars) {
      atual = tentativa;
      continue;
    }
    if (atual) linhas.push(atual);
    atual = palavra;
    if (linhas.length >= maxLinhas - 1) break;
  }
  if (atual && linhas.length < maxLinhas) linhas.push(atual);
  const usado = linhas.join(' ').length;
  if (usado < plain.length && linhas.length) {
    const last = linhas[linhas.length - 1];
    linhas[linhas.length - 1] = (last.length > 3 ? last.slice(0, -3) : last) + '…';
  }
  return linhas.length ? linhas : [plain.slice(0, maxChars)];
}

function svgLinhaComDestaques({
  segmentos,
  y,
  startX,
  fontSize,
  highlightColor,
  align,
  totalWidth,
}) {
  const spaceW = estimarLarguraChars(' ', fontSize);
  const padX = Math.round(fontSize * 0.18);
  const padY = Math.round(fontSize * 0.12);
  const boxH = Math.round(fontSize * 1.12);
  const boxY = y - fontSize + padY;

  let cursor = startX;
  if (align === 'center') {
    let lineW = 0;
    segmentos.forEach((s, i) => {
      lineW += estimarLarguraChars(s.text, fontSize);
      if (i < segmentos.length - 1) lineW += spaceW;
    });
    cursor = startX + (totalWidth - lineW) / 2;
  }

  const parts = [];
  segmentos.forEach((seg, i) => {
    const segW = estimarLarguraChars(seg.text, fontSize);
    if (seg.highlight) {
      parts.push(
        `<rect x="${cursor - padX}" y="${boxY}" width="${segW + padX * 2}" height="${boxH}" rx="3" fill="${escapeXml(highlightColor)}"/>`
      );
      parts.push(
        `<text x="${cursor}" y="${y}" fill="#0f172a" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900">${escapeXml(seg.text)}</text>`
      );
    } else {
      parts.push(
        `<text x="${cursor}" y="${y}" fill="#ffffff" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" stroke="#000" stroke-width="3" paint-order="stroke fill">${escapeXml(seg.text)}</text>`
      );
    }
    cursor += segW + (i < segmentos.length - 1 ? spaceW : 0);
  });
  return parts.join('\n');
}

/**
 * Gera PNG transparente do tamanho do vídeo com texto no estilo da marca de vídeo.
 * O texto fica no corpo do Reel (depois da capa).
 */
async function criarFaixaTextoPng({
  texto,
  posicao,
  width,
  height,
  destAbs,
  modelo = DEFAULT_VIDEO_BRAND_MODEL,
  corDestaque = '#facc15',
}) {
  const w = Math.max(320, Math.round(Number(width) || 1080));
  const h = Math.max(320, Math.round(Number(height) || 1920));
  const modeloId = normalizeVideoBrandModel(modelo);
  const highlight = /^#[0-9a-f]{6}$/i.test(String(corDestaque || ''))
    ? String(corDestaque).toLowerCase()
    : '#facc15';
  const tokens = parseTokensComDestaque(texto);
  const usaDestaque =
    modeloId === 'destaque_viral' ||
    modeloId === 'impacto_central' ||
    tokens.some((t) => t.highlight);

  let svgBody = '';

  if (modeloId === 'destaque_viral') {
    const fontSize = Math.round(w * 0.055);
    const lineH = Math.round(fontSize * 1.28);
    const maxW = Math.round(w * 0.52);
    const marginL = Math.round(w * 0.035);
    const linhas = quebrarTokensEmLinhas(tokens, maxW, fontSize, 6);
    const blockH = linhas.length * lineH;
    const baseY =
      posicao === 'topo'
        ? Math.round(h * 0.08) + fontSize
        : h - Math.round(h * 0.06) - blockH + fontSize;

    const linesSvg = linhas
      .map((segs, i) =>
        svgLinhaComDestaques({
          segmentos: segs,
          y: baseY + i * lineH,
          startX: marginL,
          fontSize,
          highlightColor: highlight,
          align: 'left',
          totalWidth: maxW,
        })
      )
      .join('\n');

    svgBody = linesSvg;
  } else if (modeloId === 'impacto_central') {
    const fontSize = Math.round(w * 0.048);
    const lineH = Math.round(fontSize * 1.3);
    const maxW = Math.round(w * 0.86);
    const linhas = quebrarTokensEmLinhas(tokens, maxW, fontSize, 5);
    const padY = Math.round(w * 0.03);
    const barH = padY * 2 + linhas.length * lineH;
    const barY = posicao === 'topo' ? Math.round(h * 0.04) : h - barH - Math.round(h * 0.05);
    const barX = Math.round(w * 0.05);
    const barW = w - barX * 2;
    const baseY = barY + padY + fontSize;

    const linesSvg = linhas
      .map((segs, i) =>
        svgLinhaComDestaques({
          segmentos: segs,
          y: baseY + i * lineH,
          startX: barX + Math.round(w * 0.02),
          fontSize,
          highlightColor: highlight,
          align: 'center',
          totalWidth: barW - Math.round(w * 0.04),
        })
      )
      .join('\n');

    svgBody = `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="14" fill="#000" fill-opacity="0.78"/>
${linesSvg}`;
  } else if (usaDestaque) {
    // Faixa topo/rodapé, mas com caixas nas palavras [[marcadas]].
    const fontSize = Math.round(w * 0.042);
    const lineH = Math.round(fontSize * 1.28);
    const maxW = Math.round(w * 0.9);
    const linhas = quebrarTokensEmLinhas(tokens, maxW, fontSize, 4);
    const padY = Math.round(w * 0.035);
    const barH = padY * 2 + linhas.length * lineH;
    const barY = posicao === 'topo' ? 0 : h - barH;
    const baseY = barY + padY + fontSize;

    const linesSvg = linhas
      .map((segs, i) =>
        svgLinhaComDestaques({
          segmentos: segs,
          y: baseY + i * lineH,
          startX: Math.round(w * 0.05),
          fontSize,
          highlightColor: highlight,
          align: 'center',
          totalWidth: maxW,
        })
      )
      .join('\n');

    svgBody = `<defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="${posicao === 'topo' ? '0.82' : '0.55'}"/>
      <stop offset="100%" stop-color="#000" stop-opacity="${posicao === 'topo' ? '0.55' : '0.88'}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${barY}" width="${w}" height="${barH}" fill="url(#bar)"/>
${linesSvg}`;
  } else {
    const plain = textoSemMarcadores(texto);
    const linhas = quebrarLinhas(plain, w >= 1000 ? 34 : 28, 4);
    const fontSize = Math.round(w * 0.042);
    const lineH = Math.round(fontSize * 1.25);
    const padY = Math.round(w * 0.035);
    const barH = padY * 2 + linhas.length * lineH;
    const barY = posicao === 'topo' ? 0 : h - barH;
    const tspans = linhas
      .map((linha, i) => {
        const y = barY + padY + fontSize + i * lineH;
        return `<tspan x="${w / 2}" y="${y}">${escapeXml(linha)}</tspan>`;
      })
      .join('');

    svgBody = `<defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="${posicao === 'topo' ? '0.82' : '0.55'}"/>
      <stop offset="100%" stop-color="#000" stop-opacity="${posicao === 'topo' ? '0.55' : '0.88'}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${barY}" width="${w}" height="${barH}" fill="url(#bar)"/>
  <text text-anchor="middle" fill="#ffffff" font-family="Arial Black, Arial, Helvetica, sans-serif"
    font-size="${fontSize}" font-weight="800" letter-spacing="0.5">${tspans}</text>`;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
${svgBody}
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

  await VideoClips.update(clip.id, {
    split_status: 'gerando',
    split_erro: null,
    split_image_origem: imagem.origem,
    split_image_url: imagem.url,
    split_video_offset: offsets.videoOffset,
    split_image_offset: offsets.imageOffset,
    split_texto: textoFinal || null,
    split_texto_posicao: posicaoFinal,
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

  await VideoClips.update(clip.id, {
    split_status: 'gerando',
    split_erro: null,
    split_texto: textoFinal || null,
    split_texto_posicao: posicaoFinal,
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
