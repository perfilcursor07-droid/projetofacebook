const fs = require('fs');
const path = require('path');

const FONTS_DIR = path.resolve(__dirname, '../../assets/fonts');

/**
 * 4 fontes principais para o título da arte.
 * Serithai Condensed (padrão): usa Barlow Condensed ExtraBold (OFL),
 * visual condensado bem próximo — a família comercial Serithai Condensed
 * não pode ser redistribuída aqui.
 */
const BRAND_FONTS = [
  {
    id: 'serithai_condensed',
    name: 'Serithai Condensed',
    file: 'BarlowCondensed-ExtraBold.ttf',
    cssFamily: "'Serithai Condensed', 'Barlow Condensed', Impact, sans-serif",
    googleCss: 'Barlow+Condensed:wght@800',
    previewWeight: 800,
    condensed: true,
  },
  {
    id: 'anton',
    name: 'Anton',
    file: 'Anton-Regular.ttf',
    cssFamily: "'Anton', Impact, sans-serif",
    googleCss: 'Anton',
    previewWeight: 400,
    condensed: true,
  },
  {
    id: 'bebas',
    name: 'Bebas Neue',
    file: 'BebasNeue-Regular.ttf',
    cssFamily: "'Bebas Neue', Impact, sans-serif",
    googleCss: 'Bebas+Neue',
    previewWeight: 400,
    condensed: true,
  },
  {
    id: 'impact',
    name: 'Impact',
    file: null,
    cssFamily: "Impact, Haettenschweiler, 'Arial Black', sans-serif",
    googleCss: null,
    previewWeight: 900,
    condensed: true,
  },
];

const DEFAULT_BRAND_FONT = 'serithai_condensed';

const TITLE_COLORS = [
  { id: 'branco', name: 'Branco', value: '#ffffff' },
  { id: 'primaria', name: 'Cor principal', value: null },
  { id: 'secundaria', name: 'Cor secundária', value: null },
  { id: 'preto', name: 'Preto', value: '#111827' },
  { id: 'amarelo', name: 'Amarelo bold', value: '#ffbd59' },
  { id: 'laranja', name: 'Laranja bold', value: '#fb923c' },
];

const DEFAULT_TITLE_COLOR = 'branco';

/** Tamanho do título em px (base 1080×1350). */
const TITLE_SIZE_MIN = 30;
const TITLE_SIZE_MAX = 50;
const DEFAULT_TITLE_SIZE = 43;

const LEGACY_TITLE_SIZES = {
  pequeno: 36,
  medio: 43,
  grande: 47,
  enorme: 50,
};

const base64Cache = new Map();

function getBrandFont(id) {
  return BRAND_FONTS.find((f) => f.id === id) || BRAND_FONTS.find((f) => f.id === DEFAULT_BRAND_FONT);
}

function normalizeBrandFont(id) {
  const found = BRAND_FONTS.find((f) => f.id === String(id || '').trim());
  return found ? found.id : DEFAULT_BRAND_FONT;
}

function normalizeTitleColor(id) {
  const found = TITLE_COLORS.find((c) => c.id === String(id || '').trim());
  return found ? found.id : DEFAULT_TITLE_COLOR;
}

function normalizeTitleSize(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (LEGACY_TITLE_SIZES[raw] != null) return LEGACY_TITLE_SIZES[raw];
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TITLE_SIZE;
  return Math.min(TITLE_SIZE_MAX, Math.max(TITLE_SIZE_MIN, Math.round(n)));
}

/** Compat: retorna meta com px + ajuste de quebra de linha. */
function getTitleSize(value) {
  const px = normalizeTitleSize(value);
  // Em 43 → 0; menores cabem mais chars; maiores, menos.
  const maxCharsBonus = Math.round((DEFAULT_TITLE_SIZE - px) / 4);
  return { px, scale: px / DEFAULT_TITLE_SIZE, maxCharsBonus };
}

function resolveTitleFill(colorId, primary, secondary) {
  const id = normalizeTitleColor(colorId);
  if (id === 'primaria') return primary || '#ffbd59';
  if (id === 'secundaria') return secondary || '#fb923c';
  const entry = TITLE_COLORS.find((c) => c.id === id);
  return entry?.value || '#ffffff';
}

function loadFontBase64(fileName) {
  if (!fileName) return null;
  if (base64Cache.has(fileName)) return base64Cache.get(fileName);
  const full = path.join(FONTS_DIR, fileName);
  if (!fs.existsSync(full)) {
    base64Cache.set(fileName, null);
    return null;
  }
  const b64 = fs.readFileSync(full).toString('base64');
  base64Cache.set(fileName, b64);
  return b64;
}

/**
 * Bloco @font-face para embutir no SVG (sharp/librsvg).
 */
function buildSvgFontFace(fontId) {
  const font = getBrandFont(fontId);
  const familyName = font.id === 'serithai_condensed' ? 'Serithai Condensed'
    : font.id === 'anton' ? 'Anton'
    : font.id === 'bebas' ? 'Bebas Neue'
    : 'Impact';

  const b64 = loadFontBase64(font.file);
  if (!b64) {
    return {
      familyName,
      cssFamily: font.cssFamily,
      faceCss: '',
    };
  }

  return {
    familyName,
    cssFamily: `'${familyName}', ${font.cssFamily}`,
    faceCss: `
      @font-face {
        font-family: '${familyName}';
        src: url('data:font/ttf;charset=utf-8;base64,${b64}') format('truetype');
        font-weight: 400 900;
        font-style: normal;
      }`,
  };
}

function googleFontsHref() {
  const families = BRAND_FONTS.map((f) => f.googleCss).filter(Boolean);
  if (!families.length) return '';
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`;
}

module.exports = {
  BRAND_FONTS,
  DEFAULT_BRAND_FONT,
  TITLE_COLORS,
  DEFAULT_TITLE_COLOR,
  TITLE_SIZE_MIN,
  TITLE_SIZE_MAX,
  DEFAULT_TITLE_SIZE,
  getBrandFont,
  normalizeBrandFont,
  normalizeTitleColor,
  normalizeTitleSize,
  getTitleSize,
  resolveTitleFill,
  buildSvgFontFace,
  googleFontsHref,
};
