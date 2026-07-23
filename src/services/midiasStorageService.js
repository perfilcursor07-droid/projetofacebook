/**
 * Biblioteca de mídias no disco (storage/) — listagem e exclusão para admin.
 */
const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const db = require('../config/db');
const { storageAbsolutePath } = require('./downloadService');

const PASTAS_PERMITIDAS = [
  'videos',
  'clips',
  'imagens',
  'artes',
  'fontes',
  'logos',
  'tmp',
  'temp',
];

const EXT_IMAGEM = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg']);
const EXT_VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.part']);

function storageRoot() {
  return path.resolve(env.storagePath);
}

function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function tipoDeArquivo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (EXT_IMAGEM.has(ext)) return 'imagem';
  if (EXT_VIDEO.has(ext)) return 'video';
  return 'outro';
}

/**
 * Normaliza e valida path relativo dentro de storage/.
 * @returns {string} path relativo com /
 */
function assertSafeRelativePath(raw) {
  const cleaned = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!cleaned || cleaned.includes('\0')) {
    const err = new Error('Caminho inválido');
    err.status = 400;
    throw err;
  }
  if (cleaned.split('/').some((p) => p === '..')) {
    const err = new Error('Caminho não permitido');
    err.status = 400;
    throw err;
  }

  const top = cleaned.split('/')[0];
  if (!PASTAS_PERMITIDAS.includes(top)) {
    const err = new Error(`Pasta não permitida: ${top}`);
    err.status = 400;
    throw err;
  }

  const root = storageRoot();
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const err = new Error('Caminho fora do storage');
    err.status = 400;
    throw err;
  }
  return cleaned.replace(/\\/g, '/');
}

function walkFiles(dirAbs, baseRel, out, { maxFiles = 2000 } = {}) {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.name === '.' || entry.name === '..') continue;
    const abs = path.join(dirAbs, entry.name);
    const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkFiles(abs, rel.replace(/\\/g, '/'), out, { maxFiles });
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = fs.statSync(abs);
      out.push({
        path: rel.replace(/\\/g, '/'),
        name: entry.name,
        size: st.size,
        sizeLabel: formatBytes(st.size),
        mtime: st.mtime.toISOString(),
        tipo: tipoDeArquivo(entry.name),
        url: `/media/${rel.replace(/\\/g, '/')}`,
      });
    } catch {
      /* ignore */
    }
  }
}

function resumoPasta(folder) {
  const abs = path.join(storageRoot(), folder);
  if (!fs.existsSync(abs)) {
    return { folder, arquivos: 0, bytes: 0, sizeLabel: '0 B', existe: false };
  }
  const files = [];
  walkFiles(abs, folder, files, { maxFiles: 5000 });
  const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
  return {
    folder,
    arquivos: files.length,
    bytes,
    sizeLabel: formatBytes(bytes),
    existe: true,
  };
}

async function listarPastas() {
  return PASTAS_PERMITIDAS.map((folder) => resumoPasta(folder));
}

/**
 * @param {{ folder?: string, q?: string, tipo?: string, limit?: number }} opts
 */
async function listarArquivos(opts = {}) {
  const folder = String(opts.folder || 'videos').trim();
  if (!PASTAS_PERMITIDAS.includes(folder)) {
    const err = new Error('Pasta inválida');
    err.status = 400;
    throw err;
  }

  const abs = path.join(storageRoot(), folder);
  const files = [];
  if (fs.existsSync(abs)) {
    walkFiles(abs, folder, files, { maxFiles: Math.min(5000, Number(opts.limit) || 2000) });
  }

  let filtered = files;
  const q = String(opts.q || '')
    .trim()
    .toLowerCase();
  if (q) {
    filtered = filtered.filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
  }
  const tipo = String(opts.tipo || '').toLowerCase();
  if (tipo === 'imagem' || tipo === 'video' || tipo === 'outro') {
    filtered = filtered.filter((f) => f.tipo === tipo);
  }

  filtered.sort((a, b) => new Date(b.mtime) - new Date(a.mtime) || b.size - a.size);

  const totalBytes = filtered.reduce((s, f) => s + f.size, 0);
  return {
    folder,
    total: filtered.length,
    totalBytes,
    sizeLabel: formatBytes(totalBytes),
    arquivos: filtered,
  };
}

async function limparReferenciasDb(relativePath) {
  const rel = relativePath.replace(/\\/g, '/');

  const jobs = [
    () => db('videos').where({ caminho_local: rel }).update({ caminho_local: null }),
    () => db('imagens').where({ caminho_local: rel }).update({ caminho_local: null }),
    () => db('video_clips').where({ caminho_arquivo: rel }).update({ caminho_arquivo: null }),
    () => db('video_clips').where({ arquivo_sem_capa: rel }).update({ arquivo_sem_capa: null }),
    () => db('ai_matters').where({ imagem_path: rel }).update({ imagem_path: null }),
    () => db('ai_matters').where({ video_path: rel }).update({ video_path: null }),
    () => db('users').where({ logo_path: rel }).update({ logo_path: null }),
  ];

  for (const job of jobs) {
    try {
      await job();
    } catch {
      /* coluna/tabela pode não existir em ambientes antigos */
    }
  }
}

async function apagarArquivo(rawPath) {
  const rel = assertSafeRelativePath(rawPath);
  const abs = storageAbsolutePath(rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const err = new Error('Arquivo não encontrado');
    err.status = 404;
    throw err;
  }

  fs.unlinkSync(abs);
  await limparReferenciasDb(rel);
  return { ok: true, path: rel };
}

async function apagarVarios(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const resultados = [];
  for (const p of list.slice(0, 100)) {
    try {
      const r = await apagarArquivo(p);
      resultados.push({ path: r.path, ok: true });
    } catch (err) {
      resultados.push({ path: String(p || ''), ok: false, error: err.message });
    }
  }
  return {
    total: resultados.length,
    apagados: resultados.filter((r) => r.ok).length,
    falhas: resultados.filter((r) => !r.ok).length,
    resultados,
  };
}

module.exports = {
  PASTAS_PERMITIDAS,
  listarPastas,
  listarArquivos,
  apagarArquivo,
  apagarVarios,
  formatBytes,
};
