const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const { env } = require('../config/env');

const WIDTH = 1080;
/**
 * Formato do feed do Facebook (4:5).
 * Preenche a largura do post no celular; 9:16 deixa faixas laterais.
 */
const HEIGHT = 1350;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeColor(value, fallback) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
}

function isPrivateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.');
}

async function assertPublicImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL da imagem editorial inválida');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protocolo de imagem não permitido');
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Endereço da imagem editorial não permitido');
  }
  return parsed.toString();
}

function resolveStoredSourcePath(value) {
  let publicUrl = String(value || '').replace(/\\/g, '/').trim();
  // https://domínio/media/fontes/... → /media/fontes/...
  try {
    if (/^https?:\/\//i.test(publicUrl)) {
      const parsed = new URL(publicUrl);
      if (parsed.pathname.startsWith('/media/')) {
        publicUrl = parsed.pathname;
      }
    }
  } catch {
    /* ignore */
  }
  if (!publicUrl.startsWith('/media/')) return null;

  const storageRoot = path.resolve(env.storagePath);
  const relativePath = publicUrl.slice('/media/'.length).replace(/\//g, path.sep);
  const absolutePath = path.resolve(storageRoot, relativePath);
  if (!absolutePath.startsWith(storageRoot + path.sep) || !fs.existsSync(absolutePath)) {
    return null;
  }
  return absolutePath;
}

function looksLikeImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

async function fetchImage(url) {
  const storedSource = resolveStoredSourcePath(url);
  if (storedSource) {
    const stats = await fs.promises.stat(storedSource);
    if (stats.size > MAX_IMAGE_BYTES) throw new Error('A imagem original excede o limite permitido');
    return fs.promises.readFile(storedSource);
  }

  const safeUrl = await assertPublicImageUrl(url);
  const host = (() => {
    try {
      return new URL(safeUrl).hostname;
    } catch {
      return '';
    }
  })();
  const isMetaCdn = /fbsbx\.com|fbcdn\.net|cdninstagram\.com|instagram\.com|facebook\.com/i.test(safeUrl);
  const isBraveCdn = /brave\.com|search\.brave|gstatic\.com|googleusercontent\.com|ggpht\.com|bing\.com|pinimg\.com|wp\.com|cloudfront\.net/i.test(
    host
  );

  const headerSets = [
    {
      'User-Agent': isMetaCdn
        ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: isMetaCdn
        ? 'https://www.facebook.com/'
        : isBraveCdn
          ? 'https://search.brave.com/'
          : 'https://www.google.com/',
    },
    {
      'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)',
      Accept: '*/*',
    },
  ];

  let lastErr = null;
  for (const headers of headerSets) {
    try {
      const response = await axios.get(safeUrl, {
        responseType: 'arraybuffer',
        timeout: 35000,
        maxRedirects: 5,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        headers,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const buf = Buffer.from(response.data || []);
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('image/') || looksLikeImageBuffer(buf)) {
        return buf;
      }
      lastErr = new Error('A fonte não retornou uma imagem válida');
    } catch (err) {
      lastErr = err;
    }
  }

  const msg =
    lastErr?.response?.status === 403 || lastErr?.response?.status === 401
      ? 'CDN bloqueou o download da imagem. Escolha outra miniatura ou envie o arquivo.'
      : lastErr?.message || 'Não foi possível baixar a imagem';
  throw new Error(msg);
}

/**
 * Tenta URL principal e, se falhar, thumbnail (útil na colagem com Brave/Serper).
 */
async function fetchImageWithFallback(primaryUrl, fallbackUrl = null) {
  const tried = [];
  const candidates = [primaryUrl, fallbackUrl]
    .map((u) => String(u || '').trim())
    .filter((u, i, arr) => u && arr.indexOf(u) === i);

  let lastErr = null;
  for (const candidate of candidates) {
    tried.push(candidate.slice(0, 80));
    try {
      return await fetchImage(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr?.message || `Falha ao baixar imagem (${tried.join(' | ')})`);
}

function stripWordPunct(word) {
  return String(word || '').replace(/^[“"'‘]+|[”"'’.,;:!?…]+$/g, '');
}

/** Token que parece nome próprio (José, Flávio, Bolsonaro…). */
function isProperNameToken(word) {
  const w = stripWordPunct(word);
  if (!w || w.length < 2) return false;
  if (/^\d+$/.test(w)) return false;
  if (/^(de|da|do|das|dos|e|a|o|as|os)$/i.test(w)) return false;
  // Inicia com maiúscula (Unicode)
  return /^[\p{Lu}]/u.test(w);
}

function isNameParticle(word) {
  return /^(de|da|do|das|dos)$/i.test(stripWordPunct(word));
}

/**
 * Agrupa nomes compostos numa unidade de quebra
 * (ex.: "Flávio Bolsonaro", "José Wellington").
 * Em CAIXA ALTA não agrupa — senão o título inteiro vira uma linha e corta.
 */
function isMostlyAllCaps(words) {
  const alpha = (words || []).filter((w) => /[\p{L}]/u.test(stripWordPunct(w)));
  if (!alpha.length) return false;
  const caps = alpha.filter((w) => {
    const s = stripWordPunct(w);
    return s.length >= 2 && s === s.toLocaleUpperCase('pt-BR');
  });
  return caps.length / alpha.length >= 0.6;
}

function glueNameUnits(words) {
  const list = Array.isArray(words) ? words : [];
  if (isMostlyAllCaps(list)) return list.slice();

  const units = [];
  let i = 0;
  while (i < list.length) {
    if (isProperNameToken(list[i])) {
      let j = i + 1;
      while (j < list.length) {
        if (isProperNameToken(list[j])) {
          j += 1;
          continue;
        }
        if (
          isNameParticle(list[j]) &&
          j + 1 < list.length &&
          isProperNameToken(list[j + 1])
        ) {
          j += 2;
          continue;
        }
        break;
      }
      // Só cola 2–4 tokens (nome), nunca um bloco enorme
      if (j - i >= 2 && j - i <= 4) {
        units.push(list.slice(i, j).join(' '));
        i = j;
        continue;
      }
    }
    units.push(list[i]);
    i += 1;
  }
  return units;
}

function wrapByUnits(units, maxChars, maxLines) {
  const lines = [];
  let current = '';

  const pushWord = (word) => {
    const w = String(word || '');
    if (!w) return;
    const candidate = current ? `${current} ${w}` : w;
    if (!current || candidate.length <= maxChars) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = w;
  };

  for (const unit of units) {
    const u = String(unit || '');
    if (!u) continue;
    // Unidade maior que a linha: quebra em palavras (nunca uma linha gigante)
    if (u.length > maxChars && /\s/.test(u)) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (const part of u.split(/\s+/)) pushWord(part);
      continue;
    }
    const candidate = current ? `${current} ${u}` : u;
    if (!current || candidate.length <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = u;
    }
  }
  if (current) lines.push(current);
  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    limited[maxLines - 1] = `${limited[maxLines - 1].replace(/[.,;:!?]?$/, '')}…`;
  }
  return limited;
}

function wrapTitle(value, maxChars = 27, maxLines = 5) {
  const rawWords = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // Cola nomes na capitalização original; depois passa para CAIXA ALTA
  const units = glueNameUnits(rawWords).map((u) => u.toLocaleUpperCase('pt-BR'));
  return wrapByUnits(units, maxChars, maxLines);
}

/** Quebra de linha sem forçar maiúsculas (modelo citação). */
function wrapTextLines(value, maxChars = 28, maxLines = 5) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return wrapByUnits(glueNameUnits(words), maxChars, maxLines);
}

/** Spans [start, endInclusive] de nomes compostos no array de palavras. */
function findNameSpans(words) {
  const spans = [];
  let i = 0;
  while (i < words.length) {
    if (!isProperNameToken(words[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < words.length) {
      if (isProperNameToken(words[j])) {
        j += 1;
        continue;
      }
      if (
        isNameParticle(words[j]) &&
        j + 1 < words.length &&
        isProperNameToken(words[j + 1])
      ) {
        j += 2;
        continue;
      }
      break;
    }
    if (j - i >= 2) spans.push({ start: i, end: j - 1 });
    i = Math.max(j, i + 1);
  }
  return spans;
}

/**
 * Escolhe o índice de corte (punch começa em cut) sem partir nomes
 * e sem deixar preposição solta no fim da manchete.
 */
function choosePunchCut(words) {
  const n = words.length;
  if (n < 5) return n;

  let punchCount = Math.min(6, Math.max(2, Math.round(n * 0.38)));
  let cut = n - punchCount;
  if (cut < 2) return n;

  const spans = findNameSpans(words);
  const moveOutOfNames = (c) => {
    let next = c;
    for (const span of spans) {
      if (next > span.start && next <= span.end) {
        const after = span.end + 1;
        const before = span.start;
        const afterOk = after >= 2 && n - after >= 2 && n - after <= 7;
        const beforeOk = before >= 2 && n - before >= 2 && n - before <= 8;
        // Prefere manter o nome inteiro na manchete (após o nome)
        if (afterOk) next = after;
        else if (beforeOk) next = before;
        else if (after >= 2 && n - after >= 2) next = after;
        else next = before;
      }
    }
    return next;
  };

  cut = moveOutOfNames(cut);

  // Prefere iniciar o marcador numa conjunção de cláusula (e / mas / que…)
  const conj = /^(e|mas|porém|porem|que)$/i;
  let bestConj = -1;
  for (let i = Math.max(2, cut - 3); i <= Math.min(n - 2, cut + 2); i += 1) {
    if (conj.test(stripWordPunct(words[i]))) bestConj = i;
  }
  // Também procura "e …" um pouco depois do nome (caso clássico: “… Bolsonaro e gera…”)
  for (let i = cut; i <= Math.min(n - 2, cut + 3); i += 1) {
    if (conj.test(stripWordPunct(words[i])) && i >= 2) bestConj = i;
  }
  if (bestConj >= 2 && n - bestConj >= 2 && n - bestConj <= 8) {
    cut = bestConj;
  }

  cut = moveOutOfNames(cut);

  // Não termina manchete com preposição/artigo solto
  const dangling =
    /^(a|o|as|os|de|do|da|dos|das|em|no|na|nos|nas|ao|à|às|para|pra|com|por|um|uma|ao)$/i;
  while (cut > 2 && dangling.test(stripWordPunct(words[cut - 1]))) {
    // Se a preposição introduz um nome, leva o nome todo para a manchete
    const nextSpan = spans.find((s) => s.start === cut);
    if (nextSpan && nextSpan.end + 1 < n && n - (nextSpan.end + 1) >= 2) {
      cut = nextSpan.end + 1;
      break;
    }
    cut -= 1;
  }

  cut = moveOutOfNames(cut);

  if (cut < 2 || n - cut < 2) return n;
  return cut;
}

/**
 * Separa manchete branca + trecho final com marcador (cor primária).
 * - Com aspas: usa a citação no marcador.
 * - Sem aspas: título da matéria inteiro; só as últimas palavras vão no marcador (sem inventar ":").
 */
function splitHeadlinePunchline(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { headline: '', punchline: '' };

  // Aspas no final: Manchete "citação"
  const quoted = raw.match(/^(.*?)[\s]*[:\-–—]?\s*[“"']([^“"'”]{8,})[”"']\s*$/);
  if (quoted) {
    let headline = quoted[1].trim().replace(/[:\-–—]\s*$/, '').trim();
    if (headline && !/[:：]$/.test(headline)) headline = `${headline}:`;
    const punch = quoted[2].trim();
    const punchline = /^['"“]/.test(punch) ? punch : `'${punch}'`;
    return { headline: headline || raw, punchline };
  }

  const midQuote = raw.match(/^(.+?)\s+[“"']([^“"'”]{8,})[”"']\s*$/);
  if (midQuote && midQuote[1].trim().length >= 12) {
    const punch = midQuote[2].trim();
    return {
      headline: midQuote[1].trim(),
      punchline: /^['"“]/.test(punch) ? punch : `'${punch}'`,
    };
  }

  // Sem aspas: mantém o texto da matéria; destaca o final no marcador
  const words = raw.split(' ').filter(Boolean);
  if (words.length >= 5) {
    const cut = choosePunchCut(words);
    if (cut >= 2 && cut < words.length) {
      return {
        headline: words.slice(0, cut).join(' '),
        punchline: words.slice(cut).join(' '),
      };
    }
  }

  return { headline: raw, punchline: '' };
}

/** Estimativa de largura de texto bold/condensado (px) — folga para não cortar o marcador. */
function estimateTextWidth(text, fontSize) {
  const s = String(text || '');
  // Folga alta: fontes black/condensadas + sombra estouram fácil nas bordas.
  let units = 0;
  for (const ch of s) {
    if (ch === ' ') units += 0.34;
    else if (/[ilI|.,:;!'`]/.test(ch)) units += 0.4;
    else if (/[mwMW@%]/.test(ch)) units += 0.9;
    else units += 0.74;
  }
  return Math.ceil(units * fontSize);
}

/**
 * Quebra texto pela largura em px (não só por contagem de chars),
 * mantendo nomes compostos juntos quando couber.
 */
function wrapTextToWidth(value, { maxWidth, fontSize, maxLines = 5, glueNames = true } = {}) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const units = glueNames ? glueNameUnits(words) : words;
  const fits = (text) => estimateTextWidth(text, fontSize) <= maxWidth;
  const lines = [];
  let current = '';

  const pushUnit = (unit) => {
    const parts = String(unit).split(' ').filter(Boolean);
    // Nome composto largo demais: quebra em palavras (último recurso)
    if (parts.length > 1 && !fits(unit) && !current) {
      for (const p of parts) {
        const candidate = current ? `${current} ${p}` : p;
        if (!current || fits(candidate)) current = candidate;
        else {
          lines.push(current);
          current = p;
        }
      }
      return;
    }
    const candidate = current ? `${current} ${unit}` : unit;
    if (!current || fits(candidate)) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = unit;
    if (!fits(current) && parts.length > 1) {
      current = '';
      for (const p of parts) {
        const c2 = current ? `${current} ${p}` : p;
        if (!current || fits(c2)) current = c2;
        else {
          lines.push(current);
          current = p;
        }
      }
    }
  };

  for (const unit of units) pushUnit(unit);
  if (current) lines.push(current);

  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    limited[maxLines - 1] = `${limited[maxLines - 1].replace(/[.,;:!?]?$/, '')}…`;
  }
  return limited;
}

function renderHighlightedLines(lines, {
  x,
  y,
  lineHeight,
  fontSize,
  padX,
  padY,
  bg,
  textFill = '#111111',
  fontFamily,
  maxWidth,
  anchor = 'start',
}) {
  return lines.map((line, index) => {
    const top = y + index * lineHeight;
    const contentW = estimateTextWidth(line, fontSize);
    const textW = Math.min(maxWidth, contentW + padX * 2 + Math.round(fontSize * 0.2));
    const rectH = Math.round(fontSize * 1.15 + padY * 2);
    const rectY = top - Math.round(fontSize * 0.88) - padY;
    const rectX = anchor === 'middle' ? Math.round(x - textW / 2) : x;
    const textX = anchor === 'middle' ? x : x + padX;
    return `
      <rect x="${rectX}" y="${rectY}" width="${textW}" height="${rectH}" fill="${bg}"/>
      <text x="${textX}" y="${top}" text-anchor="${anchor}" fill="${textFill}"
        font-family="${fontFamily}" font-weight="900" font-size="${fontSize}px">${escapeXml(line)}</text>`;
  }).join('');
}

function renderTitleLines(lines, { x, y, lineHeight, anchor = 'middle', className = 'title' }) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" class="${className}">${escapeXml(line)}</text>`
  )).join('');
}

/** Posição vertical do título no modelo Estilo Fatos (base 1350). */
function fatosTitleTopBase(lineCount) {
  if (lineCount <= 2) return 1085;
  if (lineCount === 3) return 1045;
  if (lineCount === 4) return 1005;
  return 965;
}

/** Centro vertical do divisor/logo no modelo Citação marcador (base 1350). */
function citacaoDividerY() {
  return 700;
}

function buildOverlay({
  title,
  category,
  footer,
  brandName,
  primary,
  secondary,
  hasLogo,
  model,
  width = WIDTH,
  height = HEIGHT,
  fontId,
  titleColorId,
  titleSizeId,
}) {
  const { normalizeArtModel } = require('./editorialCardModels');
  const {
    normalizeBrandFont,
    normalizeTitleColor,
    getTitleSize,
    resolveTitleFill,
    buildSvgFontFace,
  } = require('./brandFonts');

  const modelId = normalizeArtModel(model);
  const brandFontId = normalizeBrandFont(fontId);
  const sizeMeta = getTitleSize(titleSizeId);
  const titleFill = resolveTitleFill(normalizeTitleColor(titleColorId), primary, secondary);
  const fontFace = buildSvgFontFace(brandFontId);
  const titleFontFamily = fontFace.cssFamily;

  const W = Math.max(320, Math.round(Number(width) || WIDTH));
  const H = Math.max(320, Math.round(Number(height) || HEIGHT));
  const sx = W / 1080;
  const sy = H / 1350;
  const x = (n) => Math.round(n * sx);
  const y = (n) => Math.round(n * sy);
  const ww = (n) => Math.round(n * sx);
  const hh = (n) => Math.round(n * sy);
  const baseMaxChars = modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30
    : modelId === 'faixa_classica' || modelId === 'impacto_central' ? 27
    : modelId === 'minimalista' || modelId === 'faixa_topo' ? 25
    : 24;
  const maxChars = Math.max(16, baseMaxChars + (sizeMeta?.maxCharsBonus || 0));
  const isCitacao = modelId === 'citacao_marcador';
  // tamanho escolhido em Minha marca (30–50, padrão 43), escalado ao canvas
  let fontSize = Math.round((sizeMeta?.px || 43) * Math.min(sx, sy) * (isCitacao ? 1.12 : 1));
  let lineHeight = Math.round(fontSize * (modelId === 'estilo_fatos' || isCitacao ? 1.14 : 1.08));
  const safeCategory = escapeXml(category || 'ÚLTIMAS');
  const safeFooter = escapeXml(footer || brandName || '');

  // Quebra por largura real + reduz fonte se ainda passar (evita corte nas laterais).
  const textMaxW = W - ww(modelId === 'bloco_inferior' || modelId === 'barra_lateral' || modelId === 'canto_solido' || modelId === 'minimalista' ? 160 : 120);
  let lines = [];
  if (!isCitacao) {
    const titleUpper = String(title || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      lines = wrapTextToWidth(titleUpper, {
        maxWidth: textMaxW,
        fontSize,
        maxLines: 5,
        glueNames: false,
      });
      if (!lines.length) lines = wrapTitle(title, maxChars, 5);
      const widest = lines.reduce((m, line) => Math.max(m, estimateTextWidth(line, fontSize)), 0);
      if (widest <= textMaxW || fontSize <= Math.round(28 * Math.min(sx, sy))) break;
      fontSize = Math.max(Math.round(28 * Math.min(sx, sy)), Math.round(fontSize * 0.9));
      lineHeight = Math.round(fontSize * (modelId === 'estilo_fatos' ? 1.14 : 1.08));
    }
  }

  let layout;
  // Citação pode reduzir a fonte para caber; CSS precisa acompanhar.
  let headFontCss = fontSize;
  let punchFontCss = Math.round(fontSize * (isCitacao ? 0.95 : 1));

  if (isCitacao) {
    const split = splitHeadlinePunchline(title);
    const textMaxW = W - ww(140);
    let headFont = fontSize;
    let punchFont = Math.round(fontSize * 1.02);
    let headLines = [];
    let punchLines = [];
    let headLh = 0;
    let punchLh = 0;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      headLines = wrapTextToWidth(split.headline, {
        maxWidth: textMaxW,
        fontSize: headFont,
        maxLines: 5,
      });
      punchLines = split.punchline
        ? wrapTextToWidth(split.punchline, {
            maxWidth: Math.max(120, textMaxW - ww(24)),
            fontSize: punchFont,
            maxLines: 3,
          })
        : [];
      headLh = Math.round(headFont * 1.18);
      punchLh = Math.round(punchFont * 1.26);

      const widestHead = headLines.reduce(
        (m, line) => Math.max(m, estimateTextWidth(line, headFont)),
        0
      );
      const widestPunch = punchLines.reduce(
        (m, line) => Math.max(m, estimateTextWidth(line, punchFont) + Math.round(36 * sx)),
        0
      );
      if (widestHead <= textMaxW && widestPunch <= textMaxW) break;
      if (headFont <= Math.round(30 * Math.min(sx, sy))) break;
      headFont = Math.max(Math.round(30 * Math.min(sx, sy)), Math.round(headFont * 0.92));
      punchFont = Math.max(Math.round(28 * Math.min(sx, sy)), Math.round(punchFont * 0.92));
    }

    headFontCss = headFont;
    punchFontCss = punchFont;

    const totalTextH =
      headLines.length * headLh +
      (punchLines.length ? hh(18) + punchLines.length * punchLh : 0);

    // Centraliza o bloco na faixa inferior-média (não colado na base).
    const zoneTop = y(540);
    const zoneBottom = H - hh(64);
    const zoneH = Math.max(totalTextH, zoneBottom - zoneTop);
    let blockTop = zoneTop + Math.round((zoneH - totalTextH) / 2);
    blockTop = Math.max(zoneTop, Math.min(blockTop, zoneBottom - totalTextH));

    const centerX = x(540);
    const dividerY = Math.max(y(500), blockTop - hh(72));
    const punchTop = blockTop + headLines.length * headLh + hh(18);
    const markerBg = primary || '#ffd400';
    const logoGap = ww(70);

    layout = `
      <line x1="${x(48)}" y1="${dividerY}" x2="${x(540) - logoGap}" y2="${dividerY}" stroke="rgba(255,255,255,.55)" stroke-width="${Math.max(2, Math.round(3 * sy))}"/>
      <line x1="${x(540) + logoGap}" y1="${dividerY}" x2="${x(1032)}" y2="${dividerY}" stroke="rgba(255,255,255,.55)" stroke-width="${Math.max(2, Math.round(3 * sy))}"/>
      ${renderTitleLines(headLines, {
        x: centerX,
        y: blockTop + Math.round(headFont * 0.85),
        lineHeight: headLh,
        anchor: 'middle',
        className: 'title-citacao',
      })}
      ${punchLines.length
        ? renderHighlightedLines(punchLines, {
            x: centerX,
            y: punchTop + Math.round(punchFont * 0.85),
            lineHeight: punchLh,
            fontSize: punchFont,
            padX: Math.round(20 * sx),
            padY: Math.round(10 * sy),
            bg: markerBg,
            textFill: '#111111',
            fontFamily: titleFontFamily,
            maxWidth: textMaxW,
            anchor: 'middle',
          })
        : ''}`;
  } else if (modelId === 'estilo_fatos') {
    const titleTop = y(fatosTitleTopBase(lines.length));
    layout = `
      ${renderTitleLines(lines, { x: x(540), y: titleTop, lineHeight })}`;
  } else if (modelId === 'bloco_inferior') {
    layout = `
      <rect x="0" y="${y(748)}" width="${W}" height="${hh(602)}" fill="rgba(0,0,0,.74)"/>
      <rect x="0" y="${y(748)}" width="${W}" height="${hh(16)}" fill="url(#accent)"/>
      <text x="${x(72)}" y="${y(840)}" text-anchor="start" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: x(72), y: y(930), lineHeight, anchor: 'start' })}
      <text x="${x(72)}" y="${y(1295)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'minimalista') {
    layout = `
      <rect x="${x(58)}" y="${y(805)}" width="${ww(380)}" height="${hh(74)}" rx="${hh(37)}" fill="url(#accent)"/>
      <text x="${x(248)}" y="${y(855)}" text-anchor="middle" class="category category-dark">${safeCategory}</text>
      <rect x="${x(58)}" y="${y(915)}" width="${ww(230)}" height="${hh(12)}" rx="${hh(6)}" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: x(58), y: y(982), lineHeight, anchor: 'start' })}
      <text x="${x(58)}" y="${y(1302)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'barra_lateral') {
    layout = `
      <rect x="${x(58)}" y="${y(785)}" width="${ww(18)}" height="${hh(454)}" rx="${ww(9)}" fill="url(#accent)"/>
      <text x="${x(108)}" y="${y(850)}" text-anchor="start" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: x(108), y: y(934), lineHeight, anchor: 'start' })}
      <text x="${x(108)}" y="${y(1298)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'faixa_topo') {
    const titleBlockH = Math.min(hh(420), Math.round(56 * sy) + lines.length * lineHeight + Math.round(90 * sy));
    layout = `
      <rect x="${x(48)}" y="${y(772)}" width="${W - ww(96)}" height="${titleBlockH}" rx="${ww(28)}" fill="rgba(0,0,0,.55)"/>
      <rect x="${x(72)}" y="${y(798)}" width="${W - ww(144)}" height="${hh(78)}" rx="${ww(18)}" fill="url(#accent)"/>
      <text x="${x(540)}" y="${y(850)}" text-anchor="middle" class="category category-dark">${safeCategory}</text>
      ${renderTitleLines(lines, { x: x(540), y: y(930), lineHeight })}
      <text x="${x(540)}" y="${y(1298)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'moldura_editorial') {
    layout = `
      <rect x="${x(28)}" y="${y(28)}" width="${W - ww(56)}" height="${H - hh(56)}" rx="${ww(22)}" fill="none" stroke="url(#accent)" stroke-width="${Math.max(8, ww(22))}"/>
      <rect x="${x(52)}" y="${y(52)}" width="${W - ww(104)}" height="${H - hh(104)}" rx="${ww(14)}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="${Math.max(2, ww(3))}"/>
      <rect x="${x(120)}" y="${y(818)}" width="${ww(840)}" height="${hh(8)}" rx="${hh(4)}" fill="url(#accent)"/>
      <text x="${x(540)}" y="${y(800)}" text-anchor="middle" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: x(540), y: y(900), lineHeight })}
      <rect x="${x(470)}" y="${y(1248)}" width="${ww(140)}" height="${hh(6)}" rx="${hh(3)}" fill="url(#accent)"/>
      <text x="${x(540)}" y="${y(1295)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'impacto_central') {
    const plateH = Math.min(hh(460), Math.round(80 * sy) + lines.length * lineHeight + Math.round(120 * sy));
    layout = `
      <rect x="${x(64)}" y="${y(760)}" width="${W - ww(128)}" height="${plateH}" rx="${ww(32)}" fill="rgba(0,0,0,.62)"/>
      <circle cx="${x(360)}" cy="${y(812)}" r="${Math.max(4, ww(7))}" fill="url(#accent)"/>
      <circle cx="${x(720)}" cy="${y(812)}" r="${Math.max(4, ww(7))}" fill="url(#accent)"/>
      <text x="${x(540)}" y="${y(822)}" text-anchor="middle" class="category">${safeCategory}</text>
      <rect x="${x(300)}" y="${y(848)}" width="${ww(480)}" height="${hh(6)}" rx="${hh(3)}" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: x(540), y: y(930), lineHeight })}
      <text x="${x(540)}" y="${y(1298)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'canto_solido') {
    layout = `
      <polygon points="0,${y(742)} ${x(460)},${y(742)} ${x(400)},${y(872)} 0,${y(872)}" fill="url(#accent)"/>
      <text x="${x(42)}" y="${y(822)}" text-anchor="start" class="category category-dark">${safeCategory}</text>
      <rect x="${x(58)}" y="${y(900)}" width="${ww(210)}" height="${hh(10)}" rx="${hh(5)}" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: x(58), y: y(970), lineHeight, anchor: 'start' })}
      <text x="${x(58)}" y="${y(1305)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else {
    // faixa_classica (padrão): sobe o bloco se houver várias linhas
    const accentY = y(882);
    const accentHeight = Math.max(8, hh(14));
    const titleGap = Math.round(30 * sy);
    const blockH = Math.max(lineHeight, lines.length * lineHeight);
    const maxBottom = H - hh(88);
    let titleTop = accentY + accentHeight + titleGap + Math.round(fontSize * 0.78);
    if (titleTop + blockH > maxBottom) {
      titleTop = Math.max(y(760), maxBottom - blockH);
    }
    layout = `
      <text x="${x(540)}" y="${y(844)}" text-anchor="middle" class="category">${safeCategory}</text>
      <rect x="${x(58)}" y="${accentY}" width="${ww(964)}" height="${accentHeight}" rx="${Math.round(7 * sx)}" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: x(540), y: titleTop, lineHeight })}
      <text x="${x(540)}" y="${y(1310)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  }

  const brandLabel = String(brandName || '').trim();
  let fallbackBrand = '';
  if (!hasLogo && brandLabel) {
    if (modelId === 'estilo_fatos') {
      const brandY = y(fatosTitleTopBase(lines.length) - 95);
      fallbackBrand = `
        <text x="${x(540)}" y="${brandY}" text-anchor="middle" class="brand-fatos">${escapeXml(brandLabel)}</text>`;
    } else if (modelId === 'citacao_marcador') {
      // Sem texto de marca/handle — só a logo (se houver) no divisor
      fallbackBrand = '';
    } else {
      fallbackBrand = `
        <rect x="${x(240)}" y="${y(52)}" width="${ww(600)}" height="${hh(118)}" rx="${ww(28)}" fill="rgba(255,255,255,.88)"/>
        <text x="${x(540)}" y="${y(128)}" text-anchor="middle" class="brand">${escapeXml(brandLabel)}</text>`;
    }
  }

  const shadeStops = modelId === 'estilo_fatos'
    ? `
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="38%" stop-color="#000" stop-opacity="0"/>
          <stop offset="58%" stop-color="#000" stop-opacity=".45"/>
          <stop offset="78%" stop-color="#000" stop-opacity=".92"/>
          <stop offset="100%" stop-color="#000" stop-opacity="1"/>`
    : modelId === 'citacao_marcador'
    ? `
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="32%" stop-color="#000" stop-opacity="0"/>
          <stop offset="48%" stop-color="#000" stop-opacity=".22"/>
          <stop offset="68%" stop-color="#000" stop-opacity=".62"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".86"/>`
    : `
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="42%" stop-color="#000" stop-opacity=".08"/>
          <stop offset="68%" stop-color="#000" stop-opacity=".68"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".96"/>`;

  const punchFontCssFinal = punchFontCss;

  return Buffer.from(`
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          ${shadeStops}
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}"/>
          <stop offset="100%" stop-color="${secondary}"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="${Math.max(2, Math.round(3 * sy))}" stdDeviation="${Math.max(3, Math.round(4 * sy))}" flood-opacity=".75"/></filter>
        <style>
          ${fontFace.faceCss}
          .brand { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(50 * Math.min(sx, sy))}px; fill: #111827; }
          .brand-fatos { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(36 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(2 * sx))}px; fill: #fff; filter: url(#shadow); }
          .brand-citacao { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(28 * Math.min(sx, sy))}px; fill: #e5e7eb; }
          .handle { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 700; font-size: ${Math.round(28 * Math.min(sx, sy))}px; fill: #fff; filter: url(#shadow); }
          .category { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(42 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(2 * sx))}px; fill: #fff; filter: url(#shadow); }
          .category-dark { fill: #111827; filter: none; }
          .title { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${fontSize}px; fill: ${titleFill}; filter: url(#shadow); }
          .title-citacao { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${headFontCss}px; fill: #ffffff; filter: url(#shadow); }
          .title-mark { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${punchFontCssFinal}px; fill: #111111; filter: none; }
          .footer { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${Math.round(34 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(1 * sx))}px; fill: ${primary}; filter: url(#shadow); }
        </style>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#shade)"/>
      ${fallbackBrand}
      ${layout}
    </svg>
  `);
}

/**
 * Aplica overlay Minha marca (modelo escolhido) sobre uma imagem local (ex.: frame do Reel).
 */
async function composeBrandOverlayOnImage({
  imagePath,
  outputPath,
  title,
  user,
  width,
  height,
}) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error('Imagem base da capa não encontrada');
  }
  if (!title) throw new Error('Informe o título da capa');
  if (!user?.id) throw new Error('Usuário inválido para compor a capa');

  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const w = Math.max(320, Math.round(Number(width) || WIDTH));
  const h = Math.max(320, Math.round(Number(height) || HEIGHT));
  const primary = normalizeColor(user.marca_cor_primaria, '#ffbd59');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const brandName = String(user.marca_nome || '').trim();
  const maxChars = modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30 : 27;
  const titleLines = wrapTitle(title, maxChars, 5);
  const logo = await buildLogoComposite(user.logo_path, w, {
    model: modelId,
    canvasHeight: h,
    titleLineCount: titleLines.length,
  });
  const overlay = buildOverlay({
    title,
    category: user.marca_categoria || 'ÚLTIMAS',
    footer: user.marca_rodape || brandName,
    brandName,
    primary,
    secondary,
    hasLogo: Boolean(logo),
    model: modelId,
    width: w,
    height: h,
    fontId: user.marca_fonte,
    titleColorId: user.marca_titulo_cor,
    titleSizeId: user.marca_titulo_tamanho,
  });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  await sharp(imagePath, { failOn: 'error' })
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .composite(composites)
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(outputPath);

  return { outputPath, modelId, width: w, height: h };
}

async function buildLogoComposite(logoPath, canvasWidth = WIDTH, options = {}) {
  if (!logoPath) return null;
  const absolute = path.resolve(env.storagePath, logoPath);
  const storageRoot = path.resolve(env.storagePath);
  if (!absolute.startsWith(storageRoot + path.sep) || !fs.existsSync(absolute)) return null;
  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(options.model);
  const cw = Math.max(320, Math.round(Number(canvasWidth) || WIDTH));
  const ch = Math.max(320, Math.round(Number(options.canvasHeight) || HEIGHT));
  const isFatos = modelId === 'estilo_fatos';
  const isCitacao = modelId === 'citacao_marcador';
  const maxW = Math.round(cw * ((isFatos || isCitacao ? 200 : 560) / 1080));
  const maxH = Math.round(cw * ((isFatos || isCitacao ? 90 : 125) / 1080));
  const input = await sharp(absolute)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  let top = Math.round(cw * (48 / 1080));
  if (isFatos) {
    const sy = ch / 1350;
    const titleTop = Math.round(fatosTitleTopBase(options.titleLineCount || 3) * sy);
    const gap = Math.round(28 * sy);
    top = Math.max(Math.round(720 * sy), titleTop - input.info.height - gap);
  } else if (isCitacao) {
    const sy = ch / 1350;
    // Logo acima do bloco de texto, no divisor
    const approxTextTop = Math.round(980 * sy);
    top = Math.max(Math.round(640 * sy), approxTextTop - input.info.height - Math.round(36 * sy));
  }

  return {
    input: input.data,
    left: Math.max(20, Math.round((cw - input.info.width) / 2)),
    top,
  };
}

/**
 * Monta canvas 4:5 (1080×1350) para o feed do Facebook.
 * - mode: 'cover' (padrão na arte) → preenche a tela toda, sem faixa blur
 * - mode: 'auto' → se a foto for bem diferente de 4:5, contain + fundo desfocado
 */
async function buildFeedBaseImage(sourceBuffer, options = {}) {
  const forceCover = options.mode !== 'auto';

  let sourcePrepared = sourceBuffer;
  try {
    sourcePrepared = await sharp(sourceBuffer, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .toBuffer();
  } catch {
    sourcePrepared = sourceBuffer;
  }

  const meta = await sharp(sourcePrepared, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
  const srcW = Number(meta.width) || WIDTH;
  const srcH = Number(meta.height) || HEIGHT;
  const srcRatio = srcW / Math.max(1, srcH);
  const targetRatio = WIDTH / HEIGHT;
  const ratioDiff = Math.abs(srcRatio - targetRatio) / targetRatio;

  // Full-bleed: preenche 1080×1350 sem faixas pretas/blur.
  if (forceCover || ratioDiff <= 0.14) {
    return sharp(sourcePrepared, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize(WIDTH, HEIGHT, {
        fit: 'cover',
        position: 'attention',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.65, m1: 0.55, m2: 0.35 })
      .png()
      .toBuffer();
  }

  // Colagem/paisagem: mostra a imagem inteira e completa a altura com blur.
  const blurred = await sharp(sourcePrepared, { failOn: 'error', limitInputPixels: 40_000_000 })
    .resize(WIDTH, HEIGHT, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .blur(48)
    .modulate({ brightness: 0.45, saturation: 0.85 })
    .png()
    .toBuffer();

  const foreground = await sharp(sourcePrepared, { failOn: 'error', limitInputPixels: 40_000_000 })
    .resize(WIDTH, HEIGHT, {
      fit: 'inside',
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .sharpen({ sigma: 0.55, m1: 0.5, m2: 0.3 })
    .png()
    .toBuffer({ resolveWithObject: true });

  const left = Math.max(0, Math.round((WIDTH - foreground.info.width) / 2));
  const top = Math.max(0, Math.round((HEIGHT - foreground.info.height) / 2));

  return sharp(blurred)
    .composite([{ input: foreground.data, left, top }])
    .png()
    .toBuffer();
}

/**
 * Monta uma única foto 1080×1350 a partir de duas imagens.
 * layout: 'lado' (esquerda/direita) | 'cima' (acima/abaixo)
 *
 * Em cada painel: a foto aparece INTEIRA (contain), sem cortar rostos.
 * O fundo do painel é a mesma foto em blur/cover — a arte 4:5 fica cheia no Facebook.
 */
async function buildDualCollageBuffer(bufferA, bufferB, { layout = 'lado' } = {}) {
  const mode = String(layout || 'lado').toLowerCase() === 'cima' ? 'cima' : 'lado';
  const gap = 4;
  const halfW = mode === 'lado' ? Math.floor((WIDTH - gap) / 2) : WIDTH;
  const halfH = mode === 'cima' ? Math.floor((HEIGHT - gap) / 2) : HEIGHT;

  async function fitHalf(buf) {
    let prepared = buf;
    try {
      prepared = await sharp(buf, { failOn: 'error', limitInputPixels: 40_000_000 })
        .rotate()
        .toBuffer();
    } catch {
      prepared = buf;
    }

    // Fundo: preenche o painel (cover + blur) — sem “buraco” na arte do FB
    const blurred = await sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize(halfW, halfH, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .blur(36)
      .modulate({ brightness: 0.42, saturation: 0.8 })
      .png()
      .toBuffer();

    // Foto inteira dentro do painel (contain) — não corta
    const foreground = await sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize(halfW, halfH, {
        fit: 'inside',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.55, m1: 0.5, m2: 0.3 })
      .png()
      .toBuffer({ resolveWithObject: true });

    const left = Math.max(0, Math.round((halfW - foreground.info.width) / 2));
    const top = Math.max(0, Math.round((halfH - foreground.info.height) / 2));

    return sharp(blurred)
      .composite([{ input: foreground.data, left, top }])
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  }

  const [leftOrTop, rightOrBottom] = await Promise.all([fitHalf(bufferA), fitHalf(bufferB)]);

  const composites =
    mode === 'cima'
      ? [
          { input: leftOrTop, left: 0, top: 0 },
          { input: rightOrBottom, left: 0, top: halfH + gap },
        ]
      : [
          { input: leftOrTop, left: 0, top: 0 },
          { input: rightOrBottom, left: halfW + gap, top: 0 },
        ];

  return sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 3,
      background: { r: 12, g: 12, b: 18 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 96, mozjpeg: true })
    .toBuffer();
}

async function createEditorialCard({ sourceUrl, title, user }) {
  if (!sourceUrl) throw new Error('A matéria não possui imagem editorial para compor a arte');
  if (!title) throw new Error('Informe o título da arte');
  if (!user?.id) throw new Error('Usuário inválido para compor a arte');

  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const source = await fetchImage(sourceUrl);
  const primary = normalizeColor(user.marca_cor_primaria, '#ffbd59');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const brandName = String(user.marca_nome || '').trim();
  const maxChars = modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30 : 27;
  const titleLines = wrapTitle(title, maxChars, 5);
  const logo = await buildLogoComposite(user.logo_path, WIDTH, {
    model: modelId,
    canvasHeight: HEIGHT,
    titleLineCount: titleLines.length,
  });
  const overlay = buildOverlay({
    title,
    category: user.marca_categoria || 'ÚLTIMAS',
    footer: user.marca_rodape || brandName,
    brandName,
    primary,
    secondary,
    hasLogo: Boolean(logo),
    model: modelId,
    fontId: user.marca_fonte,
    titleColorId: user.marca_titulo_cor,
    titleSizeId: user.marca_titulo_tamanho,
  });

  const relativeDir = `artes/user_${user.id}`;
  const fileName = `materia_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const relativePath = `${relativeDir}/${fileName}`;
  const outputPath = path.resolve(env.storagePath, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  const feedBase = await buildFeedBaseImage(source, {
    // Sempre preenche 4:5 (cover). Faixa clássica / JM não deve ficar com strip blur.
    mode: 'cover',
  });

  await sharp(feedBase, { failOn: 'error', limitInputPixels: 40_000_000 })
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    .composite(composites)
    .jpeg({ quality: 98, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outputPath);

  return {
    relativePath,
    publicUrl: `/media/${relativePath.replace(/\\/g, '/')}`,
    width: WIDTH,
    height: HEIGHT,
    hasLogo: Boolean(logo),
    modelId,
  };
}

function removeEditorialCard(relativePath) {
  if (!relativePath) return;
  const storageRoot = path.resolve(env.storagePath);
  const artworkRoot = path.resolve(storageRoot, 'artes');
  const absolute = path.resolve(storageRoot, relativePath);
  if (!absolute.startsWith(artworkRoot + path.sep)) return;
  try {
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (err) {
    console.warn('removeEditorialCard:', err.message);
  }
}

module.exports = {
  createEditorialCard,
  composeBrandOverlayOnImage,
  removeEditorialCard,
  wrapTitle,
  wrapTextLines,
  wrapTextToWidth,
  estimateTextWidth,
  splitHeadlinePunchline,
  assertPublicImageUrl,
  fetchImage,
  fetchImageWithFallback,
  buildDualCollageBuffer,
  ART_WIDTH: WIDTH,
  ART_HEIGHT: HEIGHT,
};
