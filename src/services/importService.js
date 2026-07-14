const path = require('path');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
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
 * Busca vídeos no YouTube via yt-dlp (ytsearchN:termo).
 * Ordena pelos mais curtos primeiro (melhor para cortes de Reels).
 */
async function searchYoutube(termo, { limit = 40 } = {}) {
  const q = String(termo || '').trim();
  if (!q) {
    const err = new Error('Informe um termo para buscar no YouTube');
    err.status = 400;
    throw err;
  }

  const n = Math.min(Math.max(Number(limit) || 40, 1), 50);
  const data = await youtubedl(`ytsearch${n}:${q}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    skipDownload: true,
  });

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const videos = entries
    .map((e) => mapSearchEntry(e, 'youtube'))
    .filter(Boolean)
    .sort((a, b) => {
      const da = a.duracao == null ? Number.POSITIVE_INFINITY : a.duracao;
      const db = b.duracao == null ? Number.POSITIVE_INFINITY : b.duracao;
      return da - db;
    });

  return {
    fonte: 'youtube',
    termo: q,
    totalResults: videos.length,
    page: 1,
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
        format: 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        mergeOutputFormat: 'mp4',
        ffmpegLocation: path.dirname(ffmpegPath),
        noPlaylist: true,
        noWarnings: true,
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
  queueLinkImport,
  searchYoutube,
  searchTiktok,
};
