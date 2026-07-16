const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const youtubedlPkg = require('youtube-dl-exec');
const { runYtDlp } = require('./ytDlpAuth');
const { env } = require('../config/env');
const ffmpegPath = require('ffmpeg-static');

/** Prefere o yt-dlp do sistema (PATH do PM2 costuma não achar /usr/local/bin). */
function resolveYtDlpBinary() {
  const candidates = [
    String(process.env.YTDLP_PATH || '').trim(),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }

  try {
    const found = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', {
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    /* ignore */
  }
  return null;
}

const ytDlpBinary = resolveYtDlpBinary();
const youtubedlExec = ytDlpBinary ? youtubedlPkg.create(ytDlpBinary) : youtubedlPkg;
const youtubedl = (url, flags) => runYtDlp(youtubedlExec, url, flags);

if (env.nodeEnv === 'production') {
  console.log(`[yt-dlp] binário: ${ytDlpBinary || 'bundled (youtube-dl-exec)'}`);
}
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
    // NÃO forçar User-Agent no YouTube: o yt-dlp escolhe o cliente e os
    // headers corretos sozinho; UA de navegador causa "no formats available".
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
  if (lower.includes('sign in') || lower.includes('not a bot') || lower.includes('confirm you')) {
    return 'YouTube bloqueou a leitura neste servidor (proteção anti-bot). Atualize os cookies ou suba o arquivo por upload.';
  }
  if (lower.includes('private video') || lower.includes('private')) {
    return 'Vídeo privado — não é possível importar.';
  }
  if (lower.includes('requested format is not available') || lower.includes('no video formats')) {
    return 'Nenhum formato de vídeo disponível — cookies/JS runtime do yt-dlp podem estar faltando no servidor.';
  }
  if (lower.includes('video unavailable')) {
    return 'Vídeo indisponível nesta região ou foi removido.';
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
async function searchYoutube(termo, { limit = 100, maxDuration = null, shortsOnly = false } = {}) {
  const q = String(termo || '').trim();
  if (!q) {
    const err = new Error('Informe um termo para buscar no YouTube');
    err.status = 400;
    throw err;
  }

  const n = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const durationCap =
    maxDuration != null && Number.isFinite(Number(maxDuration))
      ? Number(maxDuration)
      : shortsOnly
        ? 60
        : null;

  // Busca até 100 itens em cada fonte para compensar duplicados e filtros de duração.
  const shortFilterUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgQQARgB`;
  const [shortsData, filteredData] = await Promise.all([
    youtubedl(`ytsearch${n}:${q} #shorts`, {
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
      playlistEnd: n,
    }).catch(() => ({ entries: [] })),
  ]);

  const byId = new Map();
  const pushEntries = (entries, fromShortSearch = false) => {
    for (const entry of entries || []) {
      const mapped = mapSearchEntry(entry, 'youtube');
      if (!mapped) continue;
      const isShort =
        /\/shorts\//i.test(mapped.url || '') ||
        (mapped.duracao != null && mapped.duracao > 0 && mapped.duracao <= 60) ||
        (fromShortSearch && mapped.duracao == null);
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

  // Uma terceira busca geral completa o catálogo mesmo quando o filtro Shorts está ativo.
  try {
    const general = await youtubedl(`ytsearch${n}:${q}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      skipDownload: true,
    });
    pushEntries(Array.isArray(general.entries) ? general.entries : [], false);
  } catch {
    // As duas buscas principais ainda podem fornecer resultados.
  }

  let videos = [...byId.values()].filter((v) => {
    if (shortsOnly) return v.isShort && (v.duracao == null || v.duracao <= 60);
    if (durationCap == null || v.duracao == null) return true;
    return v.duracao <= durationCap;
  });

  // Ranking: Shorts primeiro, depois mais curtos, depois mais views.
  videos.sort((a, b) => {
    if (Boolean(a.isShort) !== Boolean(b.isShort)) return a.isShort ? -1 : 1;
    const da = a.duracao == null ? Number.POSITIVE_INFINITY : a.duracao;
    const db = b.duracao == null ? Number.POSITIVE_INFINITY : b.duracao;
    if (da !== db) return da - db;
    return (b.views || 0) - (a.views || 0);
  });

  videos = videos.slice(0, n);

  const shortsCount = videos.filter((v) => v.isShort).length;
  const filterNotice = durationCap == null ? 'Sem limite de duração' : `Filtrado até ${durationCap}s`;

  return {
    fonte: 'youtube',
    termo: q,
    totalResults: videos.length,
    page: 1,
    maxDuration: durationCap,
    shortsCount,
    aviso:
      shortsCount > 0
        ? `${shortsCount} Short(s)/curto(s) · até ${n} resultados`
        : `${filterNotice} · até ${n} resultados`,
    videos,
  };
}

/**
 * Lista vídeos de um perfil TikTok.
 * A busca por hashtag/termo genérico não funciona de forma estável no yt-dlp —
 * use @usuario (ex.: @tiktok) ou cole o link do vídeo.
 */
async function searchTiktok(termo, { limit = 30 } = {}) {
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

  const n = Math.min(Math.max(Number(limit) || 30, 1), 60);
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
        // Sem -f rígido: no datacenter o yt-dlp escolhe o melhor stream disponível
        mergeOutputFormat: 'mp4',
        remuxVideo: 'mp4',
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

/**
 * Download de Reel FB/IG → cria um corte 9:16 → fala → matéria → capa (Minha marca).
 * Mesmo pipeline da Fila/YouTube.
 */
function queueLinkImportAsReel(video, { facebookPageId = null, matterId = null } = {}) {
  const VideoClips = require('../models/VideoClips');
  const { probe, MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } = require('./ffmpegService');
  const processingService = require('./processingService');

  enqueue(`import reel video ${video.id}`, async () => {
    try {
      const dest = `videos/video_${video.id}.mp4`;
      const abs = storageAbsolutePath(dest);

      if (!fs.existsSync(abs)) {
        await youtubedl(video.url_original, {
          output: abs,
          mergeOutputFormat: 'mp4',
          remuxVideo: 'mp4',
          ffmpegLocation: path.dirname(ffmpegPath),
          noPlaylist: true,
          noWarnings: true,
        });
      }

      let duracao = video.duracao ? Number(video.duracao) : null;
      try {
        const info = await probe(abs);
        const probed = Number(info?.format?.duration);
        if (Number.isFinite(probed) && probed > 0) duracao = Math.round(probed);
      } catch (probeErr) {
        console.warn(`[import-reel] probe #${video.id}:`, probeErr.message);
      }

      const metaBase =
        video.metadata && typeof video.metadata === 'object'
          ? video.metadata
          : (() => {
              try {
                return JSON.parse(video.metadata || '{}');
              } catch {
                return {};
              }
            })();

      await Videos.update(video.id, {
        status: 'baixado',
        caminho_local: dest,
        duracao: duracao || video.duracao || null,
        erro_mensagem: null,
        metadata: {
          ...metaBase,
          pipeline: 'conteudo_reel',
          facebook_page_id: facebookPageId || metaBase.facebook_page_id || null,
          matter_id: matterId || metaBase.matter_id || null,
        },
      });

      const fresh = await Videos.findById(video.id);
      const existing = await VideoClips.findByVideo(video.id);
      if (existing.some((c) => c.status === 'pronto' || c.status === 'processando')) {
        const ready = existing.find((c) => c.status === 'pronto' && c.caminho_arquivo);
        if (ready && (matterId || metaBase.matter_id)) {
          const { syncConteudoReelMatter } = require('./materiaIaService');
          await syncConteudoReelMatter({
            matterId: matterId || metaBase.matter_id,
            clip: ready,
            video: fresh,
          });
          if (ready.materia_status !== 'pronta' || ready.capa_status !== 'pronta') {
            processingService.queueClipMateriaAndCover(ready, fresh, {
              userId: fresh.user_id,
              force: ready.materia_status !== 'pronta',
            });
          }
        }
        console.log(`[import-reel] vídeo #${video.id} já tem corte — sincronizando matter`);
        return;
      }

      // Reel inteiro (até 90s) — um único arquivo, sem “cortes” na UI de matéria
      const fim = Math.max(
        MIN_CLIP_SECONDS,
        Math.min(Number(duracao) || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS)
      );

      const [clipId] = await VideoClips.create({
        video_id: video.id,
        inicio_segundo: 0,
        fim_segundo: fim,
        aspect_ratio: '9:16',
        legenda_sugerida: null,
        status: 'processando',
        materia_status: 'pendente',
      });

      const clip = await VideoClips.findById(clipId);
      processingService.queueClipGeneration(clip, fresh);
      console.log(
        `[import-reel] vídeo #${video.id} → clip #${clipId} (0–${fim}s) → matter #${matterId || metaBase.matter_id || '?'}`
      );
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 500);
      await Videos.update(video.id, {
        status: 'erro',
        erro_mensagem: `Importação Reel falhou: ${msg}`,
      });
      const mid =
        matterId ||
        (video.metadata && typeof video.metadata === 'object' ? video.metadata.matter_id : null);
      if (mid) {
        try {
          const AiMatters = require('../models/AiMatters');
          await AiMatters.update(mid, {
            status: 'erro',
            error_message: `Falha ao baixar o Reel: ${msg}`,
          });
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  });
}

module.exports = {
  fetchLinkMetadata,
  humanizeYtDlpError,
  queueLinkImport,
  queueLinkImportAsReel,
  searchYoutube,
  searchTiktok,
};
