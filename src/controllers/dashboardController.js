const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const VideoClips = require('../models/VideoClips');
const Publications = require('../models/Publications');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');

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

async function show(req, res, next) {
  try {
    const userId = req.session.userId;

    const [videoRows, imagemRows, clipRows, pubRows, clipsTotalRow, account, recent] =
      await Promise.all([
        Videos.countByStatus(userId),
        Imagens.countByStatus(userId),
        VideoClips.countByStatusForUser(userId),
        Publications.countByStatus(userId),
        VideoClips.countForUser(userId),
        FacebookAccounts.findByUser(userId),
        Publications.recent(userId, 12),
      ]);

    const pages = account ? await FacebookPages.findByAccount(account.id) : [];

    const videosByStatus = mapCounts(videoRows);
    const imagensByStatus = mapCounts(imagemRows);
    const clipsByStatus = mapCounts(clipRows);
    const pubsByStatus = mapCounts(pubRows);

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
      recent: recent || [],
      hasFacebook: Boolean(account),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { show };
