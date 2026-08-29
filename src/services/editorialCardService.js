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

function friendlyImageProcessingError(err) {
  const msg = String(err?.message || err || '');
  if (/heif|heic|bad seek|bitstream not supported|unsupported image format/i.test(msg)) {
    return new Error(
      'Esta foto está em formato HEIF/HEIC (comum em sites como BBC). Escolha outra imagem JPG ou PNG na matéria.'
    );
  }
  return err instanceof Error ? err : new Error(msg || 'Falha ao processar imagem');
}

/** Converte buffer de imagem para JPEG — evita falha com HEIF/AVIF quando o decoder existe. */
async function decodeImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Imagem vazia ou inválida');
  }
  try {
    return await sharp(buffer, { failOn: 'none', limitInputPixels: 40_000_000 })
      .rotate()
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    throw friendlyImageProcessingError(err);
  }
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
      Accept: 'image/jpeg,image/png,image/webp,image/apng,image/*;q=0.8',
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
function wrapTextToWidth(value, { maxWidth, fontSize, maxLines = 5, glueNames = true, keepAlertMarks = false } = {}) {
  const words = keepAlertMarks
    ? splitWordsKeepingAlertMarks(value)
    : String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const units = glueNames && !keepAlertMarks ? glueNameUnits(words) : words;
  const measure = (text) => (keepAlertMarks ? stripAlertMarks(text) : text);
  const fits = (text) => estimateTextWidth(measure(text), fontSize) <= maxWidth;
  const lines = [];
  let current = '';

  const pushUnit = (unit) => {
    const parts = keepAlertMarks
      ? [String(unit)]
      : String(unit).split(' ').filter(Boolean);
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

/** Remove os marcadores [[destaque]] e ((faixa)) do texto. */
function stripAlertMarks(value) {
  return String(value || '').replace(/\[\[|\]\]/g, '').replace(/\(\(|\)\)/g, '');
}

/** Título já tem destaque e/ou faixa do modelo Urgente alerta. */
function tituloTemMarkupAlerta(value) {
  const s = String(value || '');
  return /\[\[[^\]]+\]\]/.test(s) || /\(\([^)]+\)\)/.test(s);
}

/**
 * Garante [[destaque]] + ((faixa)) no título do modelo Urgente alerta.
 * Se a IA já marcou, mantém; senão aplica heurística estável para a arte 4:5.
 */
function ensureTituloUrgenteAlerta(titulo) {
  const raw = String(titulo || '').replace(/\s+/g, ' ').trim();
  if (!raw) return raw;

  if (tituloTemMarkupAlerta(raw)) {
    const hasDestaque = /\[\[[^\]]+\]\]/.test(raw);
    const hasFaixa = /\(\([^)]+\)\)/.test(raw);
    if (hasDestaque && hasFaixa) return raw;
    // Só um tipo: completa o que falta com o restante limpo
    if (hasDestaque && !hasFaixa) {
      const plain = stripAlertMarks(raw).replace(/\s+/g, ' ').trim();
      const words = plain.split(' ').filter(Boolean);
      if (words.length >= 6) {
        const nTail = Math.min(6, Math.max(3, Math.floor(words.length * 0.35)));
        const tail = words.slice(-nTail).join(' ');
        // Evita duplicar o trecho já em [[ ]]
        if (tail && !raw.includes(`((${tail}))`)) {
          return `${raw.replace(/\s*$/, '')} ((${tail}))`;
        }
      }
      return raw;
    }
    if (hasFaixa && !hasDestaque) {
      const before = raw.split('((')[0].replace(/\s+/g, ' ').trim();
      const words = before.split(' ').filter(Boolean);
      if (words.length >= 2) {
        const nHead = Math.min(4, Math.max(2, words.length));
        const head = words.slice(0, nHead).join(' ');
        const rest = words.slice(nHead).join(' ');
        const faixaPart = raw.slice(raw.indexOf('(('));
        return `[[${head}]]${rest ? ` ${rest}` : ''} ${faixaPart}`.replace(/\s+/g, ' ').trim();
      }
      return raw;
    }
    return raw;
  }

  const text = stripAlertMarks(raw);

  // "Citação": complemento  →  [[citação]]: ((complemento))
  const quoteColon = text.match(/^[“"'](.+?)[”"']\s*[:\-–—]\s*(.+)$/);
  if (quoteColon) {
    const left = quoteColon[1].trim();
    const right = quoteColon[2].trim();
    if (right.split(/\s+/).length >= 2) return `[[${left}]]: ((${right}))`;
    return `[[${left}]]: ${right}`;
  }

  // Manchete: subtítulo  →  [[manchete]]: ((subtítulo))
  const colonParts = text.split(/\s*[:\-–—]\s*/);
  if (colonParts.length >= 2) {
    const head = colonParts[0].replace(/^[“"']|[”"']$/g, '').trim();
    const tail = colonParts.slice(1).join(': ').trim();
    const headWords = head.split(/\s+/).filter(Boolean);
    if (head && tail && headWords.length <= 12) {
      return `[[${head}]]: ((${tail}))`;
    }
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return `[[${text}]]`;
  if (words.length <= 5) {
    const mid = Math.ceil(words.length / 2);
    return `[[${words.slice(0, mid).join(' ')}]] ((${words.slice(mid).join(' ')}))`;
  }

  const nHead = Math.min(4, Math.max(2, Math.floor(words.length * 0.32)));
  const nTail = Math.min(6, Math.max(3, Math.floor(words.length * 0.32)));
  const head = words.slice(0, nHead).join(' ');
  const mid = words.slice(nHead, words.length - nTail).join(' ');
  const tail = words.slice(words.length - nTail).join(' ');
  if (mid) return `[[${head}]] ${mid} ((${tail}))`;
  return `[[${head}]] ((${tail}))`;
}

/**
 * Garante um trecho [[destacado]] no título do modelo JM.
 *
 * O destaque azul é a marca da arte de referência. Se o editor (ou a IA) já
 * marcou, respeita; senão escolhe o nome próprio da manchete e, na falta dele,
 * um trecho do meio — nunca a manchete inteira.
 */
/** Palavras que não podem abrir nem fechar o trecho destacado. */
const JM_PALAVRAS_FRACAS = new Set([
  'a', 'o', 'as', 'os', 'e', 'ou', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'por', 'para', 'com', 'sem', 'que', 'ao', 'aos', 'à', 'às', 'um', 'uma', 'uns', 'umas', 'se',
  'seu', 'sua', 'seus', 'suas', 'mais', 'mas', 'como', 'após', 'sobre', 'entre', 'até', 'é',
]);

/** Tira palavras fracas das pontas do destaque (ex.: “e esposa são …por”). */
function jmAparaDestaque(words, inicio, fim) {
  let i = inicio;
  let f = fim;
  const limpa = (w) => String(w || '').toLowerCase().replace(/[^a-zà-ÿ]/gi, '');
  while (i < f && JM_PALAVRAS_FRACAS.has(limpa(words[i]))) i += 1;
  while (f > i && JM_PALAVRAS_FRACAS.has(limpa(words[f - 1]))) f -= 1;
  return { inicio: i, fim: f };
}

/**
 * Garante um trecho [[destacado]] no título do modelo JM.
 *
 * O destaque é a marca da arte. Se o editor (ou a IA) já marcou, respeita;
 * senão escolhe o nome próprio da manchete e, na falta dele, um trecho do meio
 * — sempre sem começar nem terminar em preposição/conjunção.
 */
function ensureTituloJm(titulo) {
  const raw = String(titulo || '').replace(/\s+/g, ' ').trim();
  if (!raw) return raw;
  if (/\[\[[^\]]+\]\]/.test(raw)) return raw;

  // Faixa vermelha não existe no JM: vira texto comum.
  const texto = raw.replace(/\(\(|\)\)/g, '').replace(/\s+/g, ' ').trim();
  const words = texto.split(' ').filter(Boolean);
  if (words.length < 4) return texto;

  const montar = (inicio, fim) => {
    const corte = jmAparaDestaque(words, inicio, fim);
    if (corte.fim - corte.inicio < 1) return texto;
    const antes = words.slice(0, corte.inicio).join(' ');
    const alvo = words.slice(corte.inicio, corte.fim).join(' ');
    const depois = words.slice(corte.fim).join(' ');
    return [antes, `[[${alvo}]]`, depois].filter(Boolean).join(' ');
  };

  // 1) Nome próprio (pessoa/instituição) é o melhor destaque.
  const spans = findNameSpans(words);
  const span = spans.find((sp) => sp.end - sp.start + 1 <= 5);
  if (span && !(span.start === 0 && span.end === words.length - 1)) {
    return montar(span.start, span.end + 1);
  }

  // 2) Sem nome próprio: trecho do meio, com no máximo 4 palavras.
  const inicio = Math.max(1, Math.round(words.length * 0.3));
  const fim = Math.min(words.length - 1, inicio + 4);
  return montar(inicio, fim);
}



/**
 * Divide o título em blocos de manchete e faixas ((assim)), preservando a ordem.
 * @returns {Array<{ type: 'text'|'band', value: string }>}
 */
function parseAlertBlocks(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const blocks = [];
  const re = /\(\(([^)]+)\)\)/g;
  let last = 0;
  let match;
  while ((match = re.exec(raw))) {
    const before = raw.slice(last, match.index).trim();
    if (before) blocks.push({ type: 'text', value: before });
    const band = match[1].trim();
    if (band) blocks.push({ type: 'band', value: band });
    last = match.index + match[0].length;
  }
  const tail = raw.slice(last).trim();
  if (tail) blocks.push({ type: 'text', value: tail });
  return blocks.length ? blocks : [{ type: 'text', value: raw }];
}

/** Separa uma linha em trechos normais e trechos marcados com [[destaque]]. */
function parseMarkedSegments(line) {
  const text = String(line || '');
  const segments = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mark: false });
    segments.push({ text: match[1], mark: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), mark: false });
  return segments.filter((segment) => segment.text !== '');
}

/** Tokens que preservam [[destaque]] e ((faixa)) juntos na quebra de linha. */
function splitWordsKeepingAlertMarks(value) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const tokens = [];
  const re = /(\[\[[^\]]+\]\]|\(\([^)]+\)\)|[^\s]+)/g;
  let m;
  while ((m = re.exec(s))) tokens.push(m[1]);
  return tokens;
}

/** Linhas de manchete com palavras [[destacadas]] em outra cor, sem caixa. */
function renderMarkedTitleLines(lines, {
  x,
  y,
  lineHeight,
  anchor = 'middle',
  className = 'title',
  markFill,
}) {
  return lines.map((line, index) => {
    const segments = parseMarkedSegments(line);
    const inner = segments.length
      ? segments
          .map((segment) => (segment.mark
            ? `<tspan fill="${markFill}">${escapeXml(segment.text)}</tspan>`
            : `<tspan>${escapeXml(segment.text)}</tspan>`))
          .join('')
      : escapeXml(stripAlertMarks(line));
    return `
      <text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" class="${className}" xml:space="preserve">${inner}</text>`;
  }).join('');
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

/**
 * Transforma [[três palavras]] em [[três]] [[palavras]].
 *
 * O wrap trata [[...]] como um token só; um destaque longo virava uma linha
 * gigante e a manchete inteira encolhia até o mínimo para tentar caber.
 * Marcando palavra a palavra, a quebra é normal e a cor continua igual.
 */
function expandirMarcacaoPorPalavra(titulo) {
  return String(titulo || '').replace(/\[\[([^\]]+)\]\]/g, (todo, dentro) => {
    const palavras = String(dentro).trim().split(/\s+/).filter(Boolean);
    if (palavras.length <= 1) return todo;
    return palavras.map((palavra) => `[[${palavra}]]`).join(' ');
  });
}


/**
 * Geometria do modelo JM (base 1080x1350), medida a partir da arte de
 * referência: foto no topo, faixa da logo no encontro e cartão branco embaixo.
 */
function jmGeometry() {
  return Object.freeze({
    barTop: 838,      // faixa da logo, logo acima da manchete
    barHeight: 34,
    barInset: 62,     // margem lateral da faixa
    titleBottom: 1264,
    titleGap: 18,
    footerY: 1312,
  });
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
  titleGap,
  painelLargura = 92,
  // Personalização do modelo (Minha marca → clicar no modelo).
  degrade = true,
  sombraFator = 1,
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
    : modelId === 'painel_premium' ? 24
    : modelId === 'urgente_alerta' ? 22
    : modelId === 'jm' ? 23
    : 24;
  const maxChars = Math.max(16, baseMaxChars + (sizeMeta?.maxCharsBonus || 0));
  const isCitacao = modelId === 'citacao_marcador';
  const isUrgente = modelId === 'urgente_alerta';
  const isJm = modelId === 'jm';
  const isPainelPremium = modelId === 'painel_premium';
  const painelPct = Math.min(100, Math.max(80, Math.round(Number(painelLargura) || 92)));
  // tamanho escolhido em Minha marca (30–50, padrão 43), escalado ao canvas
  let fontSize = Math.round(
    (sizeMeta?.px || 43) * Math.min(sx, sy) * (isCitacao ? 1.12 : isPainelPremium ? 1.12 : 1)
  );
  let lineHeight = Math.round(fontSize * (modelId === 'estilo_fatos' || isCitacao ? 1.14 : 1.08));
  const safeCategory = escapeXml(category || 'ÚLTIMAS');
  const safeFooter = escapeXml(footer || brandName || '');

  // Quebra por largura real + reduz fonte se ainda passar (evita corte nas laterais).
  const textMaxW = isPainelPremium
    ? Math.max(ww(420), Math.round((W * painelPct) / 100) - ww(330))
    : W - ww(
        modelId === 'bloco_inferior' || modelId === 'barra_lateral' || modelId === 'canto_solido' || modelId === 'minimalista'
          ? 160
          : 120
      );
  let lines = [];
  if (!isCitacao && !isUrgente && !isJm) {
    const titleUpper = String(title || '').replace(/\s+/g, ' ').trim();
    const titleForWrap = isPainelPremium
      ? titleUpper
      : titleUpper.toLocaleUpperCase('pt-BR');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      lines = wrapTextToWidth(titleForWrap, {
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
  } else if (isUrgente) {
    const alertRed = '#cc1417';
    const bannerH = hh(158);
    const textMaxW = W - ww(76);
    const bandMaxW = textMaxW - ww(40);
    const minFont = Math.round(30 * Math.min(sx, sy));

    // Faixa de plantão no topo, com a categoria ocupando a largura disponível.
    const bannerText = String(category || 'URGENTE!').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR');
    let bannerFont = Math.round(108 * Math.min(sx, sy));
    const bannerMaxW = W - ww(90);
    while (bannerFont > Math.round(38 * Math.min(sx, sy)) && estimateTextWidth(bannerText, bannerFont) > bannerMaxW) {
      bannerFont = Math.round(bannerFont * 0.93);
    }

    // Manchete e faixas vermelhas mantêm a ordem escrita pelo usuário.
    let headFont = fontSize;
    let blocks = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bandFont = Math.round(headFont * 0.66);
      blocks = parseAlertBlocks(String(title || '').toLocaleUpperCase('pt-BR')).map((block) => {
        if (block.type === 'band') {
          const bandLines = wrapTextToWidth(stripAlertMarks(block.value), {
            maxWidth: bandMaxW,
            fontSize: bandFont,
            maxLines: 2,
            glueNames: false,
          });
          return { type: 'band', lines: bandLines, fontSize: bandFont, lineHeight: Math.round(bandFont * 1.52) };
        }
        const textLines = wrapTextToWidth(block.value, {
          maxWidth: textMaxW,
          fontSize: headFont,
          maxLines: 4,
          glueNames: false,
          keepAlertMarks: true,
        });
        return { type: 'text', lines: textLines, fontSize: headFont, lineHeight: Math.round(headFont * 1.06) };
      });

      const bandGapBefore = hh(12);
      let totalH = 0;
      for (let i = 0; i < blocks.length; i += 1) {
        if (i > 0 && blocks[i].type === 'band' && blocks[i - 1].type === 'text') {
          totalH += bandGapBefore;
        }
        totalH += blocks[i].lines.length * blocks[i].lineHeight;
      }
      const available = H - bannerH - hh(40) - (hasLogo ? hh(196) : hh(116));
      if (totalH <= available || headFont <= minFont) break;
      headFont = Math.max(minFont, Math.round(headFont * 0.92));
    }

    const bandGapBefore = hh(12);
    let totalTextH = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      if (i > 0 && blocks[i].type === 'band' && blocks[i - 1].type === 'text') {
        totalTextH += bandGapBefore;
      }
      totalTextH += blocks[i].lines.length * blocks[i].lineHeight;
    }
    const bottomReserve = hasLogo ? hh(196) : hh(116);
    let cursor = Math.max(bannerH + hh(40), H - bottomReserve - totalTextH);

    let textParts = '';
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (i > 0 && block.type === 'band' && blocks[i - 1].type === 'text') {
        cursor += bandGapBefore;
      }
      if (block.type === 'band') {
        textParts += renderHighlightedLines(block.lines, {
          x: x(540),
          y: cursor + Math.round(block.fontSize * 0.92),
          lineHeight: block.lineHeight,
          fontSize: block.fontSize,
          padX: Math.round(24 * sx),
          padY: Math.round(11 * sy),
          bg: alertRed,
          textFill: '#ffffff',
          fontFamily: titleFontFamily,
          maxWidth: textMaxW,
          anchor: 'middle',
        });
      } else {
        textParts += renderMarkedTitleLines(block.lines, {
          x: x(540),
          y: cursor + Math.round(block.fontSize * 0.82),
          lineHeight: block.lineHeight,
          anchor: 'middle',
          className: 'title-urgente',
          markFill: primary,
        });
      }
      cursor += block.lines.length * block.lineHeight;
    }

    headFontCss = headFont;
    layout = `
      <rect x="0" y="0" width="${W}" height="${bannerH}" fill="${alertRed}"/>
      <text x="${x(540)}" y="${Math.round(bannerH * 0.72)}" text-anchor="middle" fill="#ffffff"
        font-family="${titleFontFamily}" font-weight="900" font-size="${bannerFont}px"
        letter-spacing="${Math.max(1, Math.round(2 * sx))}">${escapeXml(bannerText)}</text>
      ${textParts}
      ${hasLogo ? '' : `<text x="${x(540)}" y="${H - hh(52)}" text-anchor="middle" class="footer">${safeFooter}</text>`}`;
  } else if (isJm) {
    const g = jmGeometry();
    const barTop = y(g.barTop);
    const barH = Math.max(3, hh(g.barHeight));
    const barX = x(g.barInset);
    const barW = W - ww(g.barInset * 2);
    const titleGapNumber = Number(titleGap);
    const jmTitleGap = Number.isFinite(titleGapNumber)
      ? Math.min(140, Math.max(0, Math.round(titleGapNumber)))
      : g.titleGap;
    const zoneTop = barTop + barH + hh(jmTitleGap);
    const zoneBottom = y(g.titleBottom);
    const textMaxWJm = W - ww(64);
    const minFont = Math.round(30 * Math.min(sx, sy));

    // O JM usa uma escala própria, mas o tamanho escolhido precisa continuar
    // visível. O fator antigo (2.05) fazia 36, 43 e 50 terminarem iguais depois
    // do auto-fit; 1.4 preserva a diferença e ainda mantém a manchete grande.
    const tituloJm = expandirMarcacaoPorPalavra(
      ensureTituloJm(String(title || '')).toLocaleUpperCase('pt-BR')
    );
    let headFont = Math.round(fontSize * 1.4);
    let headLines = [];
    let headLh = Math.round(headFont * 1.14);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      headLines = wrapTextToWidth(tituloJm, {
        maxWidth: textMaxWJm,
        fontSize: headFont,
        maxLines: 5,
        glueNames: false,
        keepAlertMarks: true,
      });
      headLh = Math.round(headFont * 1.14);
      const widest = headLines.reduce(
        (m, line) => Math.max(m, estimateTextWidth(stripAlertMarks(line), headFont)),
        0
      );
      const totalH = headLines.length * headLh;
      if ((widest <= textMaxWJm && totalH <= zoneBottom - zoneTop) || headFont <= minFont) break;
      headFont = Math.max(minFont, Math.round(headFont * 0.94));
    }

    // A distância escolhida parte da base da faixa/logo. O auto-fit acima
    // continua protegendo o rodapé quando a manchete é muito longa.
    const totalTextH = headLines.length * headLh;
    const blockTop = Math.min(zoneTop, Math.max(barTop + barH, zoneBottom - totalTextH));

    headFontCss = headFont;
    layout = `
      <rect x="${barX}" y="${barTop}" width="${barW}" height="${barH}" fill="url(#accent)"/>
      ${hasLogo ? '' : `<text x="${x(540)}" y="${barTop + Math.round(barH * 0.8)}" text-anchor="middle" class="brand-jm">${escapeXml(String(brandName || 'NOTÍCIA').toLocaleUpperCase('pt-BR'))}</text>`}
      ${renderMarkedTitleLines(headLines, {
        x: x(540),
        y: blockTop + Math.round(headFont * 0.84),
        lineHeight: headLh,
        anchor: 'middle',
        className: 'title-jm',
        markFill: primary,
      })}
      <text x="${x(540)}" y="${y(g.footerY)}" text-anchor="middle" class="footer-jm">${safeFooter.toLocaleUpperCase('pt-BR')}</text>`;
  } else if (isPainelPremium) {
    const panelW = Math.round((W * painelPct) / 100);
    const panelX = Math.round((W - panelW) / 2);
    const panelRight = panelX + panelW;
    const panelY = y(910);
    const panelH = hh(360);
    const logoBadgeX = panelX + ww(28);
    const logoBadgeY = y(850);
    const logoBadgeW = ww(350);
    const logoBadgeH = hh(110);
    const titleTop = y(lines.length >= 5 ? 1025 : lines.length === 4 ? 1040 : 1055);
    const footerText = /^(?:not[ií]cias?|sua marca)$/i.test(
      String(footer || brandName || '').trim()
    )
      ? ''
      : safeFooter;

    layout = `
      <defs>
        <linearGradient id="premiumPanel" x1="0" y1="0" x2="1" y2=".25">
          <stop offset="0%" stop-color="#07152f" stop-opacity=".98"/>
          <stop offset="72%" stop-color="#102657" stop-opacity=".96"/>
          <stop offset="100%" stop-color="#152e66" stop-opacity=".9"/>
        </linearGradient>
        <linearGradient id="premiumGlow" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}" stop-opacity=".78"/>
          <stop offset="100%" stop-color="${degrade ? secondary : primary}" stop-opacity=".96"/>
        </linearGradient>
        <filter id="premiumShadow" x="-20%" y="-30%" width="140%" height="170%">
          <feDropShadow dx="0" dy="${hh(12)}" stdDeviation="${ww(18)}" flood-color="#020617" flood-opacity=".48"/>
        </filter>
      </defs>
      <path d="M ${panelX + ww(34)} ${panelY} H ${panelX + panelW - ww(170)} L ${panelX + panelW} ${panelY + hh(166)} V ${panelY + panelH - hh(34)} Q ${panelX + panelW} ${panelY + panelH} ${panelX + panelW - ww(34)} ${panelY + panelH} H ${panelX + ww(34)} Q ${panelX} ${panelY + panelH} ${panelX} ${panelY + panelH - hh(34)} V ${panelY + hh(34)} Q ${panelX} ${panelY} ${panelX + ww(34)} ${panelY} Z" fill="url(#premiumPanel)" filter="url(#premiumShadow)"/>
      <path d="M ${panelX + Math.round(panelW * .68)} ${panelY} H ${panelX + Math.round(panelW * .84)} L ${panelRight} ${panelY + hh(118)} V ${panelY + panelH} H ${panelX + Math.round(panelW * .76)} L ${panelX + Math.round(panelW * .64)} ${panelY + hh(250)} Z" fill="url(#premiumGlow)" opacity=".82"/>
      <circle cx="${panelRight - ww(24)}" cy="${y(980)}" r="${ww(110)}" fill="none" stroke="${secondary}" stroke-width="${ww(28)}" opacity=".34"/>
      <circle cx="${panelRight - ww(115)}" cy="${y(1200)}" r="${ww(70)}" fill="${primary}" opacity=".18"/>
      <path d="M ${panelRight - ww(230)} ${y(1240)} L ${panelRight - ww(22)} ${y(1032)}" stroke="rgba(255,255,255,.22)" stroke-width="${ww(3)}"/>
      ${hasLogo ? `<rect x="${logoBadgeX}" y="${logoBadgeY}" width="${logoBadgeW}" height="${logoBadgeH}" rx="${hh(58)}" fill="url(#accent)" stroke="rgba(255,255,255,.5)" stroke-width="${ww(2)}" filter="url(#premiumShadow)"/>` : ''}
      <text x="${panelX + ww(46)}" y="${y(985)}" text-anchor="start" class="category-premium">${safeCategory}</text>
      ${renderTitleLines(lines, { x: panelX + ww(46), y: titleTop, lineHeight, anchor: 'start', className: 'title-premium' })}
      ${footerText ? `
        <rect x="${panelX + ww(46)}" y="${y(1240)}" width="${ww(82)}" height="${hh(7)}" rx="${hh(4)}" fill="url(#accent)"/>
        <text x="${panelX + ww(146)}" y="${y(1252)}" text-anchor="start" class="footer-premium">${footerText}</text>` : ''}`;
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
    } else if (modelId === 'citacao_marcador' || isUrgente || isJm || isPainelPremium) {
      // Sem placa de marca no topo: a faixa/divisor já ocupa esse espaço.
      fallbackBrand = '';
    } else {
      fallbackBrand = `
        <rect x="${x(240)}" y="${y(52)}" width="${ww(600)}" height="${hh(118)}" rx="${ww(28)}" fill="rgba(255,255,255,.88)"/>
        <text x="${x(540)}" y="${y(128)}" text-anchor="middle" class="brand">${escapeXml(brandLabel)}</text>`;
    }
  }

  // JM escurece a foto de baixo para cima: a manchete branca vive sobre a imagem.
  const shadeStops = isPainelPremium
    ? `
          <stop offset="0%" stop-color="#000" stop-opacity=".02"/>
          <stop offset="55%" stop-color="#000" stop-opacity=".08"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".3"/>`
    : modelId === 'estilo_fatos' || isUrgente || isJm
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

  // Intensidade do escurecimento: multiplica as opacidades do gradiente.
  const fatorSombra = Math.min(1.6, Math.max(0.4, Number(sombraFator) || 1));
  const opacidadeSombra = (valor) => Math.min(1, Number((valor * fatorSombra).toFixed(3)));
  const shadeStopsFinal =
    fatorSombra === 1
      ? shadeStops
      : shadeStops.replace(/stop-opacity="([\d.]+)"/g, (todo, valor) =>
          `stop-opacity="${opacidadeSombra(Number(valor))}"`
        );

  const punchFontCssFinal = punchFontCss;

  return Buffer.from(`
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          ${shadeStopsFinal}
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}"/>
          <stop offset="100%" stop-color="${degrade ? secondary : primary}"/>
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
          .title-urgente { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${headFontCss}px; fill: #ffffff; filter: url(#shadow); }
          .title-mark { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${punchFontCssFinal}px; fill: #111111; filter: none; }
          .title-jm { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${headFontCss}px; fill: #ffffff; filter: url(#shadow); }
          .brand-jm { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${Math.round(26 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(2 * sx))}px; fill: #111827; }
          .brand-premium { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${Math.round(30 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(1.5 * sx))}px; fill: #07152f; }
          .category-premium { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: ${Math.round(25 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(2, Math.round(3 * sx))}px; fill: ${primary}; }
          .title-premium { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${fontSize}px; fill: #ffffff; filter: url(#shadow); }
          .footer-premium { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 700; font-size: ${Math.round(24 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(1, Math.round(1.2 * sx))}px; fill: #dbeafe; }
          .footer-jm { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${Math.round(34 * Math.min(sx, sy))}px; letter-spacing: ${Math.max(2, Math.round(3 * sx))}px; fill: ${primary}; filter: url(#shadow); }
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
  const { applyModelConfig } = require('./brandModelConfig');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const cfgModelo = applyModelConfig(user, modelId);
  user = cfgModelo.user;
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
    painelLargura: cfgModelo.painelLargura,
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
    titleGap: cfgModelo.tituloEspaco,
    painelLargura: cfgModelo.painelLargura,
    degrade: cfgModelo.degrade,
    sombraFator: cfgModelo.sombraFator,
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
  const isUrgente = modelId === 'urgente_alerta';
  const isJm = modelId === 'jm';
  const isPainelPremium = modelId === 'painel_premium';
  const maxW = Math.round(cw * ((isFatos || isCitacao ? 200 : isUrgente ? 330 : isJm ? 186 : isPainelPremium ? 270 : 560) / 1080));
  const maxH = Math.round(cw * ((isFatos || isCitacao ? 90 : isUrgente ? 130 : isJm ? 40 : isPainelPremium ? 72 : 125) / 1080));
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
  } else if (isUrgente) {
    // Logo centralizada no rodapé, abaixo da manchete.
    top = Math.max(0, ch - input.info.height - Math.round((ch / 1350) * 46));
  } else if (isJm) {
    // Logo centralizada sobre a faixa fina, acima da manchete.
    const g = jmGeometry();
    const syJm = ch / 1350;
    const barTop = Math.round(g.barTop * syJm);
    const barH = Math.round(g.barHeight * syJm);
    top = barTop + Math.round(barH / 2) - Math.round(input.info.height / 2);
  } else if (isPainelPremium) {
    const syPremium = ch / 1350;
    const badgeTop = Math.round(850 * syPremium);
    const badgeH = Math.round(110 * syPremium);
    top = badgeTop + Math.round((badgeH - input.info.height) / 2);
  }

  const painelPct = Math.min(
    100,
    Math.max(80, Math.round(Number(options.painelLargura) || 92))
  );
  const painelW = Math.round((cw * painelPct) / 100);
  const painelX = Math.round((cw - painelW) / 2);
  const left = isPainelPremium
    ? Math.max(
        20,
        painelX + Math.round(cw * (28 / 1080)) +
          Math.round((cw * (350 / 1080) - input.info.width) / 2)
      )
    : Math.max(20, Math.round((cw - input.info.width) / 2));

  return {
    input: input.data,
    left,
    top,
  };
}

/**
 * Cobre outW×outH com zoom e pan.
 * zoom 100 = preencher; >100 aproxima; <100 mostra mais (contain + blur).
 */
function clampArtZoom(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(180, Math.max(80, Math.round(n)));
}

function clampArtOffset(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

async function coverPaneBuffer(sourceBuffer, outW, outH, opts = {}) {
  const zoom = clampArtZoom(opts.zoom, 100);
  const offsetX = clampArtOffset(opts.offsetX, 50);
  const offsetY = clampArtOffset(opts.offsetY, 50);
  const z = zoom / 100;

  let prepared = sourceBuffer;
  try {
    prepared = await sharp(sourceBuffer, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .toBuffer();
  } catch {
    prepared = sourceBuffer;
  }

  const meta = await sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
  const srcW = Math.max(1, Number(meta.width) || outW);
  const srcH = Math.max(1, Number(meta.height) || outH);

  if (z < 1) {
    const blurred = await sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize(outW, outH, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .blur(36)
      .modulate({ brightness: 0.42, saturation: 0.8 })
      .png()
      .toBuffer();

    const fgScale = z; // 0.8 → um pouco menor que contain cheio
    const fg = await sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 })
      .resize(Math.round(outW * fgScale), Math.round(outH * fgScale), {
        fit: 'inside',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.55, m1: 0.5, m2: 0.3 })
      .png()
      .toBuffer({ resolveWithObject: true });

    const padX = Math.max(0, outW - fg.info.width);
    const padY = Math.max(0, outH - fg.info.height);
    const left = Math.round((offsetX / 100) * padX);
    const top = Math.round((offsetY / 100) * padY);

    return sharp(blurred)
      .composite([{ input: fg.data, left, top }])
      .png()
      .toBuffer();
  }

  const baseScale = Math.max(outW / srcW, outH / srcH);
  const scale = baseScale * z;
  let resizedW = Math.max(outW, Math.round(srcW * scale));
  let resizedH = Math.max(outH, Math.round(srcH * scale));

  const maxLeft = Math.max(0, resizedW - outW);
  const maxTop = Math.max(0, resizedH - outH);
  const left = Math.min(maxLeft, Math.round((offsetX / 100) * maxLeft));
  const top = Math.min(maxTop, Math.round((offsetY / 100) * maxTop));

  return sharp(prepared, { failOn: 'error', limitInputPixels: 40_000_000 })
    .resize(resizedW, resizedH, {
      fit: 'fill',
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .extract({ left, top, width: outW, height: outH })
    .sharpen({ sigma: 0.65, m1: 0.55, m2: 0.35 })
    .png()
    .toBuffer();
}

/**
 * Monta canvas 4:5 (1080×1350) para o feed do Facebook.
 * - mode: 'cover' (padrão na arte) → preenche a tela toda, sem faixa blur
 * - mode: 'auto' → se a foto for bem diferente de 4:5, contain + fundo desfocado
 * - zoom / offsetX / offsetY → enquadramento manual
 */
async function buildFeedBaseImage(sourceBuffer, options = {}) {
  const zoom = clampArtZoom(options.zoom, 100);
  const offsetX = clampArtOffset(options.offsetX, 50);
  const offsetY = clampArtOffset(options.offsetY, 50);

  // Recorte livre: mostra 100% da área selecionada, centralizada, e preenche
  // apenas as sobras da proporção 4:5 com o fundo desfocado. Nunca estica nem
  // corta novamente a seleção feita pelo usuário.
  if (options.mode === 'contain') {
    return coverPaneBuffer(sourceBuffer, WIDTH, HEIGHT, {
      zoom: 99,
      offsetX,
      offsetY,
    });
  }

  // Padrão / cover / enquadramento manual → preenche 4:5 com zoom e pan.
  if (options.mode !== 'auto') {
    return coverPaneBuffer(sourceBuffer, WIDTH, HEIGHT, { zoom, offsetX, offsetY });
  }

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

  if (ratioDiff <= 0.14) {
    return coverPaneBuffer(sourcePrepared, WIDTH, HEIGHT, { zoom: 100, offsetX: 50, offsetY: 50 });
  }

  // Paisagem muito larga: afasta um pouco + blur nas bordas.
  return coverPaneBuffer(sourcePrepared, WIDTH, HEIGHT, { zoom: 90, offsetX: 50, offsetY: 50 });
}

/**
 * Monta uma única foto 1080×1350 a partir de duas imagens.
 * layout: 'lado' (esquerda/direita) | 'cima' (acima/abaixo)
 *
 * Em cada painel: cover (fotos grandes, cortando as bordas) + zoom/pan opcional.
 */
async function buildDualCollageBuffer(bufferA, bufferB, opts = {}) {
  const layout = opts.layout || 'lado';
  const mode = String(layout || 'lado').toLowerCase() === 'cima' ? 'cima' : 'lado';
  const gap = 4;
  const halfW = mode === 'lado' ? Math.floor((WIDTH - gap) / 2) : WIDTH;
  const halfH = mode === 'cima' ? Math.floor((HEIGHT - gap) / 2) : HEIGHT;

  // Default 108: preenche o painel e corta um pouco as bordas (as duas ficam grandes).
  const zoomA = clampArtZoom(opts.zoomA ?? opts.zoom, 108);
  const zoomB = clampArtZoom(opts.zoomB ?? opts.zoom, zoomA);
  const offsetXA = clampArtOffset(opts.offsetXA ?? opts.offsetX, 50);
  const offsetYA = clampArtOffset(opts.offsetYA ?? opts.offsetY, 50);
  const offsetXB = clampArtOffset(opts.offsetXB ?? opts.offsetX, offsetXA);
  const offsetYB = clampArtOffset(opts.offsetYB ?? opts.offsetY, offsetYA);

  async function fitHalf(buf, zoom, offsetX, offsetY) {
    const pane = await coverPaneBuffer(buf, halfW, halfH, { zoom, offsetX, offsetY });
    return sharp(pane).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  }

  const [leftOrTop, rightOrBottom] = await Promise.all([
    fitHalf(bufferA, zoomA, offsetXA, offsetYA),
    fitHalf(bufferB, zoomB, offsetXB, offsetYB),
  ]);

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

async function createEditorialCard({ sourceUrl, title, user, zoom, offsetX, offsetY, fitMode, model } = {}) {
  if (!sourceUrl) throw new Error('A matéria não possui imagem editorial para compor a arte');
  if (!title) throw new Error('Informe o título da arte');
  if (!user?.id) throw new Error('Usuário inválido para compor a arte');

  const { resolveArtModelForMatter } = require('./editorialCardModels');
  const { applyModelConfig } = require('./brandModelConfig');
  const modelId = resolveArtModelForMatter(user, model);
  // Ajustes que o editor fez neste modelo em Minha marca.
  const cfgModelo = applyModelConfig(user, modelId);
  user = cfgModelo.user;
  let source = await fetchImage(sourceUrl);
  try {
    source = await decodeImageBuffer(source);
  } catch (err) {
    throw friendlyImageProcessingError(err);
  }
  const primary = normalizeColor(user.marca_cor_primaria, '#ffbd59');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const brandName = String(user.marca_nome || '').trim();
  const maxChars = modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30 : 27;
  const titleLines = wrapTitle(title, maxChars, 5);
  const logo = await buildLogoComposite(user.logo_path, WIDTH, {
    model: modelId,
    canvasHeight: HEIGHT,
    titleLineCount: titleLines.length,
    painelLargura: cfgModelo.painelLargura,
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
    titleGap: cfgModelo.tituloEspaco,
    painelLargura: cfgModelo.painelLargura,
    degrade: cfgModelo.degrade,
    sombraFator: cfgModelo.sombraFator,
  });

  const relativeDir = `artes/user_${user.id}`;
  const fileName = `materia_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const relativePath = `${relativeDir}/${fileName}`;
  const outputPath = path.resolve(env.storagePath, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  const feedBase = await buildFeedBaseImage(source, {
    mode: fitMode === 'contain' ? 'contain' : 'cover',
    // Sem enquadramento manual na matéria, vale o tamanho de foto do modelo.
    zoom: zoom != null ? zoom : cfgModelo.zoom != null ? cfgModelo.zoom : 100,
    offsetX: offsetX != null ? offsetX : 50,
    offsetY: offsetY != null ? offsetY : 50,
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

/**
 * PNG transparente só com Minha marca (gradiente + título + logo).
 * Serve para prévia de enquadramento: foto zoom por baixo, marca fixa por cima.
 */
/** Foto sintética neutra usada como fundo das miniaturas de modelo. */
async function buildPreviewPhoto(w, h) {
  const svg = Buffer.from(`
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#64748b"/>
          <stop offset="55%" stop-color="#3b4756"/>
          <stop offset="100%" stop-color="#1c2430"/>
        </linearGradient>
        <radialGradient id="spot" cx="50%" cy="32%" r="48%">
          <stop offset="0%" stop-color="#dbe3ec" stop-opacity=".95"/>
          <stop offset="100%" stop-color="#dbe3ec" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#bg)"/>
      <ellipse cx="${Math.round(w * 0.5)}" cy="${Math.round(h * 0.3)}" rx="${Math.round(w * 0.23)}" ry="${Math.round(h * 0.19)}" fill="url(#spot)"/>
      <ellipse cx="${Math.round(w * 0.5)}" cy="${Math.round(h * 0.74)}" rx="${Math.round(w * 0.36)}" ry="${Math.round(h * 0.28)}" fill="#94a3b8" opacity=".38"/>
    </svg>`);
  return sharp(svg).png().toBuffer();
}

/**
 * Miniatura real de um modelo de arte, usando o mesmo renderizador das artes finais.
 * Serve para o usuário comparar os modelos em Minha marca.
 */
async function buildBrandModelPreviewPng({
  user,
  model,
  title,
  width = 432,
  height = 540,
  overrides = {},
} = {}) {
  const { normalizeArtModel } = require('./editorialCardModels');
  const { applyModelConfig } = require('./brandModelConfig');
  const modelId = normalizeArtModel(model);
  // overrides: prévia ao vivo do painel de personalização, antes de salvar.
  const cfgModelo = applyModelConfig(user, modelId, overrides);
  user = cfgModelo.user;
  const w = Math.max(160, Math.round(Number(width) || 432));
  const h = Math.max(200, Math.round(Number(height) || 540));
  const primary = normalizeColor(user?.marca_cor_primaria, '#ffbd59');
  const secondary = normalizeColor(user?.marca_cor_secundaria, '#fb923c');
  const brandName = String(user?.marca_nome || '').trim();
  const headline = String(title || '').replace(/\s+/g, ' ').trim()
    || 'Lula arruma briga ao defender Lulinha: "quem quer me atacar começa por ele"';

  const base = await buildPreviewPhoto(w, h);
  const titleLines = wrapTitle(headline, modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30 : 27, 5);
  const logo = await buildLogoComposite(user?.logo_path, w, {
    model: modelId,
    canvasHeight: h,
    titleLineCount: titleLines.length,
    painelLargura: cfgModelo.painelLargura,
  });
  const overlay = buildOverlay({
    title: headline,
    category: user?.marca_categoria || 'ÚLTIMAS',
    footer: user?.marca_rodape || brandName,
    brandName,
    primary,
    secondary,
    hasLogo: Boolean(logo),
    model: modelId,
    width: w,
    height: h,
    fontId: user?.marca_fonte,
    titleColorId: user?.marca_titulo_cor,
    titleSizeId: user?.marca_titulo_tamanho,
    titleGap: cfgModelo.tituloEspaco,
    painelLargura: cfgModelo.painelLargura,
    degrade: cfgModelo.degrade,
    sombraFator: cfgModelo.sombraFator,
  });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  return sharp(base).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

async function buildBrandOverlayPng({ title, user } = {}) {
  if (!title) throw new Error('Informe o título da arte');
  if (!user?.id) throw new Error('Usuário inválido para compor a arte');

  const { normalizeArtModel } = require('./editorialCardModels');
  const { applyModelConfig } = require('./brandModelConfig');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const cfgModelo = applyModelConfig(user, modelId);
  user = cfgModelo.user;
  const primary = normalizeColor(user.marca_cor_primaria, '#ffbd59');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const brandName = String(user.marca_nome || '').trim();
  const maxChars = modelId === 'estilo_fatos' || modelId === 'citacao_marcador' ? 30 : 27;
  const titleLines = wrapTitle(title, maxChars, 5);
  const logo = await buildLogoComposite(user.logo_path, WIDTH, {
    model: modelId,
    canvasHeight: HEIGHT,
    titleLineCount: titleLines.length,
    painelLargura: cfgModelo.painelLargura,
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
    titleGap: cfgModelo.tituloEspaco,
    painelLargura: cfgModelo.painelLargura,
    degrade: cfgModelo.degrade,
    sombraFator: cfgModelo.sombraFator,
  });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  const blank = await sharp({
    create: {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();

  return sharp(blank)
    .composite(composites)
    .png()
    .toBuffer();
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
  buildBrandOverlayPng,
  buildBrandModelPreviewPng,
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
  stripAlertMarks,
  tituloTemMarkupAlerta,
  ensureTituloJm,
  ensureTituloUrgenteAlerta,
  ART_WIDTH: WIDTH,
  ART_HEIGHT: HEIGHT,
};
