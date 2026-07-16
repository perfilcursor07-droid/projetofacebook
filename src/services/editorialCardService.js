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
  const maxChars = ['faixa_classica', 'manchete', 'vidro'].includes(modelId) ? 26
    : modelId === 'minimalista' ? 25
    : 24;
  const lines = wrapTitle(title, maxChars, 5);
  const fontSize = lines.length <= 3 ? 62 : lines.length === 4 ? 54 : 48;
  const lineHeight = Math.round(fontSize * 1.08);
  const titleBlockH = lines.length * lineHeight;
  const safeCategory = escapeXml(category || 'ÚLTIMAS');
  const safeFooter = escapeXml(footer || brandName || '');
  const catLen = String(category || 'ÚLTIMAS').length;
  const badgeW = Math.max(220, Math.min(520, 48 + catLen * 28));

  const y = (n) => Math.round((n / 1350) * HEIGHT);
  const h = (n) => Math.round((n / 1350) * HEIGHT);

  let layout;
  let shadeStops = `
    <stop offset="0%" stop-color="#000" stop-opacity="0"/>
    <stop offset="40%" stop-color="#000" stop-opacity=".06"/>
    <stop offset="66%" stop-color="#000" stop-opacity=".62"/>
    <stop offset="100%" stop-color="#000" stop-opacity=".96"/>`;

  if (modelId === 'bloco_inferior') {
    layout = `
      <rect x="0" y="${y(720)}" width="${WIDTH}" height="${h(630)}" fill="rgba(0,0,0,.78)"/>
      <rect x="0" y="${y(720)}" width="${WIDTH}" height="8" fill="url(#accent)"/>
      <rect x="64" y="${y(768)}" width="${badgeW}" height="52" rx="8" fill="url(#accent)"/>
      <text x="${64 + badgeW / 2}" y="${y(804)}" text-anchor="middle" class="category category-dark category-sm">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 64, y: y(890), lineHeight, anchor: 'start' })}
      <text x="64" y="${y(1298)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'minimalista') {
    layout = `
      <rect x="56" y="${y(798)}" width="${badgeW}" height="64" rx="32" fill="url(#accent)"/>
      <text x="${56 + badgeW / 2}" y="${y(840)}" text-anchor="middle" class="category category-dark category-sm">${safeCategory}</text>
      <rect x="56" y="${y(892)}" width="160" height="8" rx="4" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 56, y: y(960), lineHeight, anchor: 'start' })}
      <text x="56" y="${y(1305)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'barra_lateral') {
    layout = `
      <rect x="48" y="${y(760)}" width="14" height="${h(480)}" rx="7" fill="url(#accent)"/>
      <text x="90" y="${y(820)}" text-anchor="start" class="category">${safeCategory}</text>
      <rect x="90" y="${y(848)}" width="120" height="6" rx="3" fill="url(#accent)"/>
      ${renderTitleLines(lines, { x: 90, y: y(920), lineHeight, anchor: 'start' })}
      <text x="90" y="${y(1300)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'vidro') {
    const panelTop = y(760);
    const panelH = h(520);
    shadeStops = `
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="48%" stop-color="#000" stop-opacity=".12"/>
      <stop offset="72%" stop-color="#000" stop-opacity=".45"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".7"/>`;
    layout = `
      <rect x="40" y="${panelTop}" width="${WIDTH - 80}" height="${panelH}" rx="28" fill="rgba(8,12,20,.62)"/>
      <rect x="40" y="${panelTop}" width="${WIDTH - 80}" height="6" rx="3" fill="url(#accent)"/>
      <rect x="72" y="${panelTop + 36}" width="${badgeW}" height="48" rx="10" fill="url(#accent)"/>
      <text x="${72 + badgeW / 2}" y="${panelTop + 68}" text-anchor="middle" class="category category-dark category-sm">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 72, y: panelTop + 140, lineHeight, anchor: 'start' })}
      <text x="72" y="${panelTop + panelH - 36}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'manchete') {
    const boxH = Math.max(280, 120 + titleBlockH + 80);
    const boxY = HEIGHT - boxH - 56;
    shadeStops = `
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="50%" stop-color="#000" stop-opacity=".15"/>
      <stop offset="78%" stop-color="#000" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".85"/>`;
    layout = `
      <rect x="40" y="${boxY}" width="${WIDTH - 80}" height="${boxH}" rx="22" fill="rgba(0,0,0,.82)"/>
      <rect x="40" y="${boxY}" width="14" height="${boxH}" rx="7" fill="url(#accent)"/>
      <text x="86" y="${boxY + 58}" text-anchor="start" class="category">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 86, y: boxY + 130, lineHeight, anchor: 'start' })}
      <text x="86" y="${boxY + boxH - 36}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'fita_diagonal') {
    layout = `
      <polygon points="0,${y(780)} 520,${y(780)} 460,${y(880)} 0,${y(880)}" fill="url(#accent)"/>
      <text x="36" y="${y(845)}" text-anchor="start" class="category category-dark category-sm">${safeCategory}</text>
      ${renderTitleLines(lines, { x: 56, y: y(960), lineHeight, anchor: 'start' })}
      <rect x="56" y="${y(1265)}" width="200" height="8" rx="4" fill="url(#accent)"/>
      <text x="56" y="${y(1310)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else if (modelId === 'ticker') {
    shadeStops = `
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="45%" stop-color="#000" stop-opacity=".08"/>
      <stop offset="70%" stop-color="#000" stop-opacity=".55"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".92"/>`;
    layout = `
      ${renderTitleLines(lines, { x: 56, y: y(900), lineHeight, anchor: 'start' })}
      <rect x="0" y="${y(1185)}" width="${WIDTH}" height="${h(165)}" fill="rgba(0,0,0,.88)"/>
      <rect x="0" y="${y(1185)}" width="18" height="${h(165)}" fill="url(#accent)"/>
      <rect x="48" y="${y(1225)}" width="${badgeW}" height="46" rx="6" fill="url(#accent)"/>
      <text x="${48 + badgeW / 2}" y="${y(1256)}" text-anchor="middle" class="category category-dark category-sm">${safeCategory}</text>
      <text x="56" y="${y(1315)}" text-anchor="start" class="footer">${safeFooter}</text>`;
  } else {
    const accentY = y(882);
    const accentHeight = 12;
    const titleGap = 28;
    const titleTop = accentY + accentHeight + titleGap + Math.round(fontSize * 0.78);
    layout = `
      <text x="540" y="${y(840)}" text-anchor="middle" class="category">${safeCategory}</text>
      <rect x="200" y="${accentY}" width="680" height="${accentHeight}" rx="6" fill="url(#accent)"/>
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
          ${shadeStops}
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${primary}"/>
          <stop offset="100%" stop-color="${secondary}"/>
        </linearGradient>
        <filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity=".75"/></filter>
        <style>
          .brand { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: 50px; fill: #111827; }
          .category { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: 38px; letter-spacing: 2px; fill: #fff; filter: url(#shadow); }
          .category-sm { font-size: 30px; letter-spacing: 1.5px; }
          .category-dark { fill: #111827; filter: none; }
          .title { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 900; font-size: ${fontSize}px; fill: #fff; filter: url(#shadow); }
          .footer { font-family: Arial, 'Segoe UI', sans-serif; font-weight: 800; font-size: 30px; letter-spacing: 1px; fill: ${primary}; filter: url(#shadow); }
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

  // Base full-bleed 4:5: fundo desfocado + foto em cover (sem faixas laterais no arquivo).
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
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
    .toBuffer();

  await sharp(background)
    .composite([{ input: foreground, gravity: 'centre' }, ...composites])
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
