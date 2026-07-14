const path = require('path');
const youtubedlPkg = require('youtube-dl-exec');
const { runYtDlp } = require('./ytDlpAuth');
const { env } = require('../config/env');
const ffmpegPath = require('ffmpeg-static');

// Usa binário do sistema se disponível (mais atualizado), senão fallback para o bundled
const ytDlpBinary = (() => {
  const custom = String(process.env.YTDLP_PATH || '').trim();
  if (custom) return custom;
  try {
    const { execSync } = require('child_process');
    const systemPath = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', { encoding: 'utf8' }).trim().split('\n')[0];
    if (systemPath) return systemPath;
  } catch {}
  return null;
})();

const youtubedlExec = ytDlpBinary
  ? youtubedlPkg.create(ytDlpBinary)
  : youtubedlPkg;

const youtubedl = (url, flags) => runYtDlp(youtubedlExec, url, flags);
const Videos = require('../models/Videos');
const { enqueue } = require('../workers/queue');
const { storageAbsolutePath } = require('./downloadService');

/**
 * Metadados de um link (YouTube, TikTok, URL direta) via yt-dlp.
 */
async function fetchLinkMetadata(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
    // Ajuda em servidores/datacenter onde o YouTube é mais restritivo
    addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
    socketTimeout: 30,
    retries: 2,
  });

  return {
    titulo: info.title || null,
    duracao: info.duration ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail || null,
    autor: info.uploader || info.channel || null,
    autorUrl: info.uploader_url || info.channel_url || null,
    extractor: info.extractor_key || null,
  };
}

function humanizeYtDlpError(err) {
  const raw = String(err?.stderr || err?.message || err || '');
  const lower = raw.toLowerCase();
  if (lower.includes('sign in') || lower.includes('bot') || lower.includes('confirm you')) {
    return 'YouTube bloqueou a leitura neste servidor (proteção anti-bot). Tente outro link, Shorts, ou suba o arquivo por upload.';
  }
  if (lower.includes('private video') || lower.includes('private')) {
    return 'Vídeo privado — não é possível importar.';
  }
  if (lower.includes('video unavailable') || lower.includes('not available')) {
    return 'Vídeo indisponível nesta região ou foi removido.';
  }
  if (lower.includes('requested format is not available') || lower.includes('no video formats')) {
    return 'Nenhum formato de vídeo disponível — o vídeo pode estar bloqueado nesta região ou ter restrições.';
  }
  if (lower.includes('unsupported url') || lower.includes('no video')) {
    return 'URL não suportada. Use link do YouTube/TikTok/vídeo direto.';
  }
  if (lower.includes('enoent') || lower.includes('spawn') || lower.includes('yt-dlp')) {
    return 'Ferramenta yt-dlp ausente/desatualizada no servidor. Atualize youtube-dl-exec.';
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 280) || 'falha ao ler o link';
}

function pickThumbnail(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const thumbs = entry.thumbnails;
  if (Array.isArray(thumbs) && thumbs.length) {
    const best = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return best?.url || null;
  }
  if (entry.id && (entry.ie_key === 'Youtube' || entry.extractor_key === 'Youtube')) {
    return `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
  }
  return null;
}

function mapSearchEntry(entry, source) {
  const url =
    entry.webpage_url ||
    entry.url ||
    (source === 'youtube' && entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
  if (!url) return null;

  return {
    id: String(entry.id || url),
    source,
    titulo: entry.title || (entry.description ? String(entry.description).slice(0, 80) : null) || 'Sem título',
    url,
    thumbnail: pickThumbnail(entry),
    duracao: entry.duration ? Math.round(entry.duration) : null,
    autor: entry.uploader || entry.channel || entry.creator || null,
    autorUrl: entry.uploader_url || entry.channel_url || null,
    views: entry.view_count || null,
  };
}

/**
 * Busca vídeos no YouTube via yt-dlp.
 * Prioriza Shorts e vídeos curtos (melhores para cortes de Reels).
 *
 * @param {string} termo
 * @param {{ limit?: number, maxDuration?: number|null, shortsOnly?: boolean }} opts
 */
async function searchYoutube(termo, { limit = 40, maxDuration = null, shortsOnly = false } = {}) {
  const q = String(termo || '').trim();
  if (!q) {
    const err = new Error('Informe um termo para buscar no YouTube');
    err.status = 400;
    throw err;
  }

  const n = Math.min(Math.max(Number(limit) || 40, 1), 50);
  const half = Math.max(8, Math.ceil(n / 2));
  const durationCap =
    maxDuration != null && Number.isFinite(Number(maxDuration))
      ? Number(maxDuration)
      : shortsOnly
        ? 60
        : 180;

  // Busca em paralelo: Shorts + resultados filtrados “curtos” (< 4 min no YouTube)
  const shortFilterUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgQQARgB`;

  const [shortsData, filteredData] = await Promise.all([
    youtubedl(`ytsearch${half}:${q} #shorts`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      skipDownload: true,
    }).catch(() => ({ entries: [] })),
    youtubedl(shortFilterUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      skipDownload: true,
      playlistEnd: half,
    }).catch(() => ({ entries: [] })),
  ]);

  const byId = new Map();
  const pushEntries = (entries, forceShort = false) => {
    for (const entry of entries || []) {
      const mapped = mapSearchEntry(entry, 'youtube');
      if (!mapped) continue;
      const isShort =
        forceShort ||
        /\/shorts\//i.test(mapped.url || '') ||
        (mapped.duracao != null && mapped.duracao > 0 && mapped.duracao <= 60);
      mapped.isShort = Boolean(isShort);
      if (byId.has(mapped.id)) {
        const prev = byId.get(mapped.id);
        byId.set(mapped.id, { ...prev, ...mapped, isShort: prev.isShort || mapped.isShort });
      } else {
        byId.set(mapped.id, mapped);
      }
    }
  };

  pushEntries(Array.isArray(shortsData.entries) ? shortsData.entries : [], true);
  pushEntries(Array.isArray(filteredData.entries) ? filteredData.entries : [], false);

  // Se veio pouco resultado, completa com busca geral
  if (byId.size < Math.min(12, n) && !shortsOnly) {
    try {
      const general = await youtubedl(`ytsearch${n}:${q}`, {
        dumpSingleJson: true,
        flatPlaylist: true,
        noWarnings: true,
        skipDownload: true,
      });
      pushEntries(Array.isArray(general.entries) ? general.entries : [], false);
    } catch {
      // ignore
    }
  }

  let videos = [...byId.values()].filter((v) => {
    if (v.duracao == null) return !shortsOnly;
    if (shortsOnly) return v.duracao <= 60;
    return v.duracao <= durationCap;
  });

  // Ranking: Shorts primeiro, depois mais curtos, depois mais views
  videos.sort((a, b) => {
    if (Boolean(a.isShort) !== Boolean(b.isShort)) return a.isShort ? -1 : 1;
    const da = a.duracao == null ? Number.POSITIVE_INFINITY : a.duracao;
    const db = b.duracao == null ? Number.POSITIVE_INFINITY : b.duracao;
    if (da !== db) return da - db;
    return (b.views || 0) - (a.views || 0);
  });

  videos = videos.slice(0, n);

  const shortsCount = videos.filter((v) => v.isShort).length;

  return {
    fonte: 'youtube',
    termo: q,
    totalResults: videos.length,
    page: 1,
    maxDuration: durationCap,
    shortsCount,
    aviso:
      shortsCount > 0
        ? `${shortsCount} Short(s)/curto(s) · priorizados para Reels`
        : `Filtrado até ${durationCap}s · experimente outro termo ou filtre “todos”`,
    videos,
  };
}

/**
 * Lista vídeos de um perfil TikTok.
 * A busca por hashtag/termo genérico não funciona de forma estável no yt-dlp —
 * use @usuario (ex.: @tiktok) ou cole o link do vídeo.
 */
async function searchTiktok(termo, { limit = 12 } = {}) {
  const raw = String(termo || '').trim();
  if (!raw) {
    const err = new Error('Informe um @usuário do TikTok (ex.: @tiktok)');
    err.status = 400;
    throw err;
  }

  if (/^https?:\/\//i.test(raw) && /\/video\//i.test(raw)) {
    const meta = await fetchLinkMetadata(raw);
    return {
      fonte: 'tiktok',
      termo: raw,
      totalResults: 1,
      page: 1,
      videos: [
        {
          id: raw,
          source: 'tiktok',
          titulo: meta.titulo || 'Vídeo TikTok',
          url: raw,
          thumbnail: meta.thumbnail,
          duracao: meta.duracao,
          autor: meta.autor,
          autorUrl: meta.autorUrl,
          views: null,
        },
      ],
      aviso: null,
    };
  }

  const username = raw.replace(/^@/, '').split(/[/?#]/)[0].trim();
  if (!username || /\s/.test(username) || username.length < 2) {
    const err = new Error(
      'No TikTok, busque por @usuario (ex.: @tiktok). Busca por hashtag/termo não está disponível — cole o link do vídeo se preferir.'
    );
    err.status = 400;
    throw err;
  }

  const n = Math.min(Math.max(Number(limit) || 12, 1), 30);
  const profileUrl = `https://www.tiktok.com/@${username}`;

  try {
    const data = await youtubedl(profileUrl, {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: n,
      noWarnings: true,
      skipDownload: true,
    });

    const entries = Array.isArray(data.entries) ? data.entries : data.id ? [data] : [];
    const videos = entries.map((e) => mapSearchEntry(e, 'tiktok')).filter(Boolean);

    return {
      fonte: 'tiktok',
      termo: `@${username}`,
      totalResults: videos.length,
      page: 1,
      videos,
      aviso:
        'TikTok lista os vídeos do perfil informado (busca por termo genérico não é suportada pelo yt-dlp).',
    };
  } catch (err) {
    const msg = String(err.stderr || err.message || err).slice(0, 300);
    const error = new Error(`Não foi possível listar @${username}: ${msg}`);
    error.status = 422;
    throw error;
  }
}

/** Enfileira download de um vídeo importado por link. */
function queueLinkImport(video) {
  enqueue(`import link video ${video.id}`, async () => {
    try {
      const dest = `videos/video_${video.id}.mp4`;
      await youtubedl(video.url_original, {
        output: storageAbsolutePath(dest),
        format: 'best[ext=mp4]/best',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: path.dirname(ffmpegPath),
        noPlaylist: true,
        noWarnings: true,
        addHeader: [
          'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ],
        retries: 3,
      });

      await Videos.update(video.id, {
        status: 'baixado',
        caminho_local: dest,
        erro_mensagem: null,
      });
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 500);
      await Videos.update(video.id, {
        status: 'erro',
        erro_mensagem: `Importação falhou: ${msg}`,
      });
      throw err;
    }
  });
}

module.exports = {
  fetchLinkMetadata,
  humanizeYtDlpError,
  queueLinkImport,
  searchYoutube,
  searchTiktok,
};
