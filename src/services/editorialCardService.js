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
  const publicUrl = String(value || '').replace(/\\/g, '/');
  if (!publicUrl.startsWith('/media/fontes/')) return null;

  const storageRoot = path.resolve(env.storagePath);
  const sourcesRoot = path.resolve(storageRoot, 'fontes');
  const relativePath = publicUrl.slice('/media/'.length).replace(/\//g, path.sep);
  const absolutePath = path.resolve(storageRoot, relativePath);
  if (!absolutePath.startsWith(sourcesRoot + path.sep) || !fs.existsSync(absolutePath)) {
    throw new Error('A imagem original escolhida não foi encontrada');
  }
  return absolutePath;
}

async function fetchImage(url) {
  const storedSource = resolveStoredSourcePath(url);
  if (storedSource) {
    const stats = await fs.promises.stat(storedSource);
    if (stats.size > MAX_IMAGE_BYTES) throw new Error('A imagem original excede o limite permitido');
    return fs.promises.readFile(storedSource);
  }

  const safeUrl = await assertPublicImageUrl(url);
  const isMetaCdn = /fbsbx\.com|fbcdn\.net|cdninstagram\.com|instagram\.com|facebook\.com/i.test(safeUrl);
  const response = await axios.get(safeUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 4,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': isMetaCdn
        ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
        : 'Mozilla/5.0 (compatible; ViralizeAI/1.0)',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: isMetaCdn ? 'https://www.facebook.com/' : undefined,
    },
  });
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('A fonte não retornou uma imagem válida');
  return Buffer.from(response.data);
}

function wrapTitle(value, maxChars = 27, maxLines = 5) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('pt-BR').split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    limited[maxLines - 1] = `${limited[maxLines - 1].replace(/[.,;:!?]?$/, '')}…`;
  }
  return limited;
}

/** Quebra de linha sem forçar maiúsculas (modelo citação). */
function wrapTextLines(value, maxChars = 28, maxLines = 5) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    limited[maxLines - 1] = `${limited[maxLines - 1].replace(/[.,;:!?]?$/, '')}…`;
  }
  return limited;
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
    // ~últimas 35–40% das palavras (mín. 2, máx. 6)
    const punchCount = Math.min(6, Math.max(2, Math.round(words.length * 0.38)));
    const cut = words.length - punchCount;
    if (cut >= 2) {
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
  // Condensed bold costuma ficar perto de 0.58–0.65em; usamos folga alta.
  let units = 0;
  for (const ch of s) {
    if (ch === ' ') units += 0.32;
    else if (/[ilI|.,:;!'`]/.test(ch)) units += 0.38;
    else if (/[mwMW@%]/.test(ch)) units += 0.85;
    else units += 0.68;
  }
  return Math.ceil(units * fontSize);
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
  const lines = isCitacao ? [] : wrapTitle(title, maxChars, 5);
  // tamanho escolhido em Minha marca (30–50, padrão 43), escalado ao canvas
  const fontSize = Math.round((sizeMeta?.px || 43) * Math.min(sx, sy) * (isCitacao ? 1.12 : 1));
  const lineHeight = Math.round(fontSize * (modelId === 'estilo_fatos' || isCitacao ? 1.14 : 1.08));
  const safeCategory = escapeXml(category || 'ÚLTIMAS');
  const safeFooter = escapeXml(footer || brandName || '');

  let layout;

  if (isCitacao) {
    const split = splitHeadlinePunchline(title);
    const headLines = wrapTextLines(split.headline, maxChars, 4);
    const punchLines = split.punchline
      ? wrapTextLines(split.punchline, Math.max(18, maxChars - 2), 3)
      : [];
    const headFont = fontSize;
    const headLh = Math.round(headFont * 1.16);
    const punchFont = Math.round(fontSize * 1.02);
    const punchLh = Math.round(punchFont * 1.24);
    const centerX = x(540);
    const textMaxW = W - ww(96);
    const totalTextH =
      headLines.length * headLh +
      (punchLines.length ? hh(16) + punchLines.length * punchLh : 0);
    const textBottomPad = hh(52);
    const blockTop = H - textBottomPad - totalTextH;
    const dividerY = Math.max(y(620), blockTop - hh(70));
    const punchTop = blockTop + headLines.length * headLh + hh(16);
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
            padX: Math.round(18 * sx),
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
    const accentY = y(882);
    const accentHeight = Math.max(8, hh(14));
    const titleGap = Math.round(30 * sy);
    const titleTop = accentY + accentHeight + titleGap + Math.round(fontSize * 0.78);
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
          <stop offset="45%" stop-color="#000" stop-opacity="0"/>
          <stop offset="62%" stop-color="#000" stop-opacity=".28"/>
          <stop offset="82%" stop-color="#000" stop-opacity=".72"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".88"/>`
    : `
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="42%" stop-color="#000" stop-opacity=".08"/>
          <stop offset="68%" stop-color="#000" stop-opacity=".68"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".96"/>`;

  const punchFontCss = Math.round(fontSize * (isCitacao ? 0.95 : 1));

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
          .title-citacao { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${fontSize}px; fill: #ffffff; filter: url(#shadow); }
          .title-mark { font-family: ${titleFontFamily}; font-weight: 900; font-size: ${punchFontCss}px; fill: #111111; filter: none; }
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
 * - Foto quase 4:5 → full-bleed (cover)
 * - Foto larga/paisagem (colagens) → imagem inteira (contain) + fundo desfocado
 * - mode: 'cover' → sempre preenche a arte inteira (sem faixas), usado no Citação marcador
 */
async function buildFeedBaseImage(sourceBuffer, options = {}) {
  const forceCover = options.mode === 'cover';

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
        position: forceCover ? 'centre' : 'attention',
        withoutEnlargement: false,
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.6, m1: 0.5, m2: 0.3 })
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
    // Citação marcador: foto em toda a arte (sem faixa blur / strip)
    mode: modelId === 'citacao_marcador' ? 'cover' : 'auto',
  });

  await sharp(feedBase, { failOn: 'error', limitInputPixels: 40_000_000 })
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    .composite(composites)
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4', mozjpeg: true })
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
  assertPublicImageUrl,
  ART_WIDTH: WIDTH,
  ART_HEIGHT: HEIGHT,
};
