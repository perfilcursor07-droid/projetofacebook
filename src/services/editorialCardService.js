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
  const response = await axios.get(safeUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 4,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)' },
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

function renderTitleLines(lines, { x, y, lineHeight, anchor = 'middle' }) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" class="title">${escapeXml(line)}</text>`
  )).join('');
}

function buildOverlay({ title, category, footer, brandName, primary, secondary, hasLogo, model }) {
  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(model);
  const maxChars = modelId === 'faixa_classica' || modelId === 'impacto_central' ? 27
    : modelId === 'minimalista' || modelId === 'faixa_topo' ? 25
    : 24;
  const lines = wrapTitle(title, maxChars, 5);
  const fontSize = lines.length <= 3 ? 62 : lines.length === 4 ? 54 : 48;
  const lineHeight = Math.round(fontSize * 1.08);
  const safeCategory = escapeXml(category || 'ÚLTIMAS');
  const safeFooter = escapeXml(footer || brandName || '');

  // Layout proporcional à altura 9:16 (base visual antiga 1350 → 1920)
  const y = (n) => Math.round((n / 1350) * HEIGHT);
  const h = (n) => Math.round((n / 1350) * HEIGHT);

  let layout;

  if (modelId === 'bloco_inferior') {
    layout = `
      <rect x="0" y="${y(748)}" width="${WIDTH}" height="${h(602)}" fill="rgba(0,0,0,.74)"/>
      <rect x="0" y="${y(748)}" width="${WIDTH}" height="16" fill="url(#accent)"/>
      <text x="72" y="${y(840)}" text-anchor="start" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 72, y: y(930), lineHeight, anchor: 'start' })}
      <text x="72" y="${y(1295)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'minimalista') {
    layout = `
      <rect x="58" y="${y(805)}" width="380" height="74" rx="37" fill="url(#accent)"/>
      <text x="248" y="${y(855)}" text-anchor="middle" class="category category-dark">${safeCategory}</text>
      <rect x="58" y="${y(915)}" width="230" height="12" rx="6" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 58, y: y(982), lineHeight, anchor: 'start' })}
      <text x="58" y="${y(1302)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'barra_lateral') {
    layout = `
      <rect x="58" y="${y(785)}" width="18" height="${h(454)}" rx="9" fill="url(#accent)"/>
      <text x="108" y="${y(850)}" text-anchor="start" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 108, y: y(934), lineHeight, anchor: 'start' })}
      <text x="108" y="${y(1298)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'faixa_topo') {
    const titleBlockH = Math.min(h(420), 56 + lines.length * lineHeight + 90);
    layout = `
      <rect x="48" y="${y(772)}" width="${WIDTH - 96}" height="${titleBlockH}" rx="28" fill="rgba(0,0,0,.55)"/>
      <rect x="72" y="${y(798)}" width="${WIDTH - 144}" height="78" rx="18" fill="url(#accent)"/>
      <text x="540" y="${y(850)}" text-anchor="middle" class="category category-dark">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 540, y: y(930), lineHeight })}
      <text x="540" y="${y(1298)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'moldura_editorial') {
    layout = `
      <rect x="28" y="28" width="${WIDTH - 56}" height="${HEIGHT - 56}" rx="22" fill="none" stroke="url(#accent)" stroke-width="22"/>
      <rect x="52" y="52" width="${WIDTH - 104}" height="${HEIGHT - 104}" rx="14" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="3"/>
      <rect x="120" y="${y(818)}" width="840" height="8" rx="4" fill="url(#accent)"/>
      <text x="540" y="${y(800)}" text-anchor="middle" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 540, y: y(900), lineHeight })}
      <rect x="470" y="${y(1248)}" width="140" height="6" rx="3" fill="url(#accent)"/>
      <text x="540" y="${y(1295)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'impacto_central') {
    const plateH = Math.min(h(460), 80 + lines.length * lineHeight + 120);
    layout = `
      <rect x="64" y="${y(760)}" width="${WIDTH - 128}" height="${plateH}" rx="32" fill="rgba(0,0,0,.62)"/>
      <circle cx="360" cy="${y(812)}" r="7" fill="url(#accent)"/>
      <circle cx="720" cy="${y(812)}" r="7" fill="url(#accent)"/>
      <text x="540" y="${y(822)}" text-anchor="middle" class="category">${safeCategory}</text>
      <rect x="300" y="${y(848)}" width="480" height="6" rx="3" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 540, y: y(930), lineHeight })}
      <text x="540" y="${y(1298)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'canto_solido') {
    layout = `
      <polygon points="0,${y(742)} 460,${y(742)} 400,${y(872)} 0,${y(872)}" fill="url(#accent)"/>
      <text x="42" y="${y(822)}" text-anchor="start" class="category category-dark">${safeCategory}</text>
      <rect x="58" y="${y(900)}" width="210" height="10" rx="5" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 58, y: y(970), lineHeight, anchor: 'start' })}
      <text x="58" y="${y(1305)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else {
    const accentY = y(882);
    const accentHeight = 14;
    const titleGap = 30;
    const titleTop = accentY + accentHeight + titleGap + Math.round(fontSize * 0.78);
    layout = `
      <text x="540" y="${y(844)}" text-anchor="middle" class="category">${safeCategory}</text>
      <rect x="58" y="${accentY}" width="964" height="${accentHeight}" rx="7" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 540, y: titleTop, lineHeight })}
      <text x="540" y="${y(1310)}" text-anchor="middle" class="footer">${safeFooter}</text>`;
  }

  const fallbackBrand = hasLogo || !String(brandName || '').trim() ? '' : `
    <rect x="240" y="52" width="600" height="118" rx="28" fill="rgba(255,255,255,.88)"/>
    <text x="540" y="128" text-anchor="middle" class="brand">${escapeXml(brandName)}</text>`;

  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="42%" stop-color="#000" stop-opacity=".08"/>
          <stop offset="68%" stop-color="#000" stop-opacity=".68"/>
          <stop offset="100%" stop-color="#000" stop-opacity=".96"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}"/>
          <stop offset="100%" stop-color="${secondary}"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity=".75"/></filter>
        <style>
          .brand { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: 50px; fill: #111827; }
          .category { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: 42px; letter-spacing: 2px; fill: #fff; filter: url(#shadow); }
          .category-dark { fill: #111827; filter: none; }
          .title { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${fontSize}px; fill: #fff; filter: url(#shadow); }
          .footer { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: 34px; letter-spacing: 1px; fill: ${primary}; filter: url(#shadow); }
        </style>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
      ${fallbackBrand}
      ${layout}
    </svg>
  `);
}

async function buildLogoComposite(logoPath) {
  if (!logoPath) return null;
  const absolute = path.resolve(env.storagePath, logoPath);
  const storageRoot = path.resolve(env.storagePath);
  if (!absolute.startsWith(storageRoot + path.sep) || !fs.existsSync(absolute)) return null;
  const input = await sharp(absolute)
    .resize(560, 125, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    input: input.data,
    left: Math.max(30, Math.round((WIDTH - input.info.width) / 2)),
    top: 48,
  };
}

async function createEditorialCard({ sourceUrl, title, user }) {
  if (!sourceUrl) throw new Error('A matéria não possui imagem editorial para compor a arte');
  if (!title) throw new Error('Informe o título da arte');
  if (!user?.id) throw new Error('Usuário inválido para compor a arte');

  const { normalizeArtModel } = require('./editorialCardModels');
  const modelId = normalizeArtModel(user.marca_modelo_arte);
  const source = await fetchImage(sourceUrl);
  const logo = await buildLogoComposite(user.logo_path);
  const primary = normalizeColor(user.marca_cor_primaria, '#facc15');
  const secondary = normalizeColor(user.marca_cor_secundaria, '#fb923c');
  const brandName = String(user.marca_nome || '').trim();
  const overlay = buildOverlay({
    title,
    category: user.marca_categoria || 'ÚLTIMAS',
    footer: user.marca_rodape || brandName,
    brandName,
    primary,
    secondary,
    hasLogo: Boolean(logo),
    model: modelId,
  });

  const relativeDir = `artes/user_${user.id}`;
  const fileName = `materia_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const relativePath = `${relativeDir}/${fileName}`;
  const outputPath = path.resolve(env.storagePath, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const composites = [{ input: overlay, left: 0, top: 0 }];
  if (logo) composites.push(logo);

  // Base 4:5: fundo desfocado em cover + foto inteira em contain (sem cortar o assunto).
  let sourcePrepared = source;
  try {
    sourcePrepared = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .trim({ threshold: 35 })
      .toBuffer();
  } catch {
    sourcePrepared = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .toBuffer();
  }

  const background = await sharp(sourcePrepared)
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .blur(42)
    .modulate({ brightness: 0.78 })
    .toBuffer();

  const foreground = await sharp(sourcePrepared)
    .resize(WIDTH, HEIGHT, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  await sharp(background)
    .composite([
      {
        input: foreground.data,
        left: Math.max(0, Math.round((WIDTH - foreground.info.width) / 2)),
        top: Math.max(0, Math.round((HEIGHT - foreground.info.height) / 2)),
      },
      ...composites,
    ])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outputPath);

  // Garante metadados exatos (alguns viewers usam isso)
  const meta = await sharp(outputPath).metadata();
  if (meta.width !== WIDTH || meta.height !== HEIGHT) {
    await sharp(outputPath)
      .resize(WIDTH, HEIGHT, { fit: 'fill' })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(outputPath);
  }

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
  removeEditorialCard,
  wrapTitle,
  assertPublicImageUrl,
  ART_WIDTH: WIDTH,
  ART_HEIGHT: HEIGHT,
};
