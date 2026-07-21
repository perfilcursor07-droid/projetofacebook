const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const VideoClips = require('../models/VideoClips');
const Publications = require('../models/Publications');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');

const CHART_DAYS = 7;

function mapCounts(rows) {
  const out = {};
  for (const row of rows || []) {
    out[row.status] = Number(row.total) || 0;
  }
  return out;
}

function sumCounts(map) {
  return Object.values(map).reduce((a, b) => a + Number(b || 0), 0);
}

function toDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function mapDayCounts(rows) {
  const out = {};
  for (const row of rows || []) {
    const key = toDateKey(row.dia);
    if (key) out[key] = Number(row.total) || 0;
  }
  return out;
}

function lastNDays(n) {
  const labels = [];
  const keys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = toDateKey(d);
    keys.push(key);
    labels.push(
      d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
    );
  }
  return { labels, keys };
}

function seriesFromMap(keys, map) {
  return keys.map((k) => Number(map[k] || 0));
}

async function show(req, res, next) {
  try {
    const userId = req.session.userId;

    const [
      videoRows,
      imagemRows,
      clipRows,
      pubRows,
      clipsTotalRow,
      account,
      recent,
      videosByDayRows,
      clipsByDayRows,
      pubsByDayRows,
      imagensByDayRows,
    ] = await Promise.all([
      Videos.countByStatus(userId),
      Imagens.countByStatus(userId),
      VideoClips.countByStatusForUser(userId),
      Publications.countByStatus(userId),
      VideoClips.countForUser(userId),
      FacebookAccounts.findByUser(userId),
      Publications.recent(userId, 12),
      Videos.countByDay(userId, CHART_DAYS),
      VideoClips.countByDayForUser(userId, CHART_DAYS),
      Publications.countByDay(userId, CHART_DAYS),
      Imagens.countByDay(userId, CHART_DAYS),
    ]);

    const pages = account ? await FacebookPages.findByAccount(account.id) : [];

    const videosByStatus = mapCounts(videoRows);
    const imagensByStatus = mapCounts(imagemRows);
    const clipsByStatus = mapCounts(clipRows);
    const pubsByStatus = mapCounts(pubRows);

    const { labels, keys } = lastNDays(CHART_DAYS);
    const activity = {
      labels,
      videos: seriesFromMap(keys, mapDayCounts(videosByDayRows)),
      clips: seriesFromMap(keys, mapDayCounts(clipsByDayRows)),
      publicacoes: seriesFromMap(keys, mapDayCounts(pubsByDayRows)),
      imagens: seriesFromMap(keys, mapDayCounts(imagensByDayRows)),
    };

    res.render('dashboard', {
      title: 'Dashboard',
      stats: {
        videos: sumCounts(videosByStatus),
        imagens: sumCounts(imagensByStatus),
        clips: Number(clipsTotalRow?.total) || 0,
        publicacoes: sumCounts(pubsByStatus),
        paginas: pages.length,
        videosByStatus,
        imagensByStatus,
        clipsByStatus,
        pubsByStatus,
      },
      charts: {
        activity,
        videosByStatus,
        clipsByStatus,
        pubsByStatus,
      },
      recent: recent || [],
      hasFacebook: Boolean(account),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { show };
