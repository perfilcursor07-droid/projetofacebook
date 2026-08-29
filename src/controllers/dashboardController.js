const Videos = require('../models/Videos');
const Imagens = require('../models/Imagens');
const VideoClips = require('../models/VideoClips');
const Publications = require('../models/Publications');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const AiMatters = require('../models/AiMatters');
const BibliotecaAgenda = require('../models/BibliotecaAgenda');

const CHART_DAYS = 7; // matérias + produção

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

function n(value) {
  return Number(value) || 0;
}

function buildNextAction({ connected, matterStats, agendaStats }) {
  const rascunhos = n(matterStats.rascunho);
  const agendadas = n(matterStats.agendado);
  const erros = n(matterStats.erro);
  const total = n(matterStats.all);
  const agendaPendente = n(agendaStats.pendente);

  if (!connected) {
    return {
      kicker: 'Comece por aqui',
      title: 'Conecte a Página do Facebook',
      text: 'Sem Página conectada, as matérias não saem no ar.',
      href: '/paginas',
      cta: 'Ir para Páginas',
      tone: 'amber',
    };
  }

  if (erros > 0) {
    return {
      kicker: 'Atenção',
      title: `${erros} matéria${erros > 1 ? 's' : ''} com erro`,
      text: 'Abra o rascunho, corrija e agende de novo.',
      href: '/minhas-materias?status=erro',
      cta: 'Ver erros',
      tone: 'rose',
    };
  }

  if (agendaPendente > 0) {
    return {
      kicker: 'Biblioteca',
      title: `${agendaPendente} pauta${agendaPendente > 1 ? 's' : ''} esperando confirmação`,
      text: 'Confirme o horário para a matéria entrar na agenda de publicação.',
      href: '/biblioteca',
      cta: 'Abrir biblioteca',
      tone: 'sky',
    };
  }

  if (rascunhos > 0) {
    return {
      kicker: 'Em redação',
      title: `${rascunhos} rascunho${rascunhos > 1 ? 's' : ''} para terminar`,
      text: 'Revise título, arte e horário — depois agende ou publique.',
      href: '/minhas-materias?status=rascunho',
      cta: 'Ver rascunhos',
      tone: 'slate',
    };
  }

  if (agendadas > 0) {
    return {
      kicker: 'Na agenda',
      title: `${agendadas} matéria${agendadas > 1 ? 's' : ''} já na fila de publicação`,
      text: 'Acompanhe o horário ou crie a próxima pauta.',
      href: '/minhas-materias?status=agendado',
      cta: 'Ver agendadas',
      tone: 'emerald',
    };
  }

  if (total === 0) {
    return {
      kicker: 'Primeiro passo',
      title: 'Crie a primeira matéria',
      text: 'Pauta, link ou texto — o chat monta título, arte e post.',
      href: '/materia-manual',
      cta: 'Criar matéria',
      tone: 'emerald',
    };
  }

  return {
    kicker: 'Continuar',
    title: 'Pronto para a próxima matéria',
    text: 'Use o chat, os virais ou a biblioteca para gerar o próximo post.',
    href: '/materia-manual',
    cta: 'Criar matéria',
    tone: 'emerald',
  };
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
      matterStatsRaw,
      recentMatters,
      scheduledMatters,
      agendaStats,
      mattersByDayRows,
    ] = await Promise.all([
      Videos.countByStatus(userId),
      Imagens.countByStatus(userId),
      VideoClips.countByStatusForUser(userId),
      Publications.countByStatus(userId),
      VideoClips.countForUser(userId),
      FacebookAccounts.findByUser(userId),
      Publications.recent(userId, 8),
      Videos.countByDay(userId, CHART_DAYS),
      VideoClips.countByDayForUser(userId, CHART_DAYS),
      Publications.countByDay(userId, CHART_DAYS),
      Imagens.countByDay(userId, CHART_DAYS),
      AiMatters.countByStatusForUser(userId),
      AiMatters.findRecentWithPage(userId, 6),
      AiMatters.findByUserWithPub(userId, { limit: 5, status: 'agendado' }),
      BibliotecaAgenda.countByStatus(userId),
      AiMatters.countByDay(userId, CHART_DAYS),
    ]);

    const pages = account ? await FacebookPages.findByAccount(account.id) : [];

    const videosByStatus = mapCounts(videoRows);
    const imagensByStatus = mapCounts(imagemRows);
    const clipsByStatus = mapCounts(clipRows);
    const pubsByStatus = mapCounts(pubRows);
    const matterStats = matterStatsRaw || {};

    const { labels, keys } = lastNDays(CHART_DAYS);
    const activity = {
      labels,
      materias: seriesFromMap(keys, mapDayCounts(mattersByDayRows)),
      videos: seriesFromMap(keys, mapDayCounts(videosByDayRows)),
      clips: seriesFromMap(keys, mapDayCounts(clipsByDayRows)),
      publicacoes: seriesFromMap(keys, mapDayCounts(pubsByDayRows)),
      imagens: seriesFromMap(keys, mapDayCounts(imagensByDayRows)),
    };

    const connected = Boolean(account);
    const nextAction = buildNextAction({
      connected,
      matterStats,
      agendaStats: agendaStats || {},
    });

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
      matterStats,
      charts: {
        activity,
        videosByStatus,
        clipsByStatus,
        pubsByStatus,
        mattersByStatus: {
          rascunho: n(matterStats.rascunho),
          pronto: n(matterStats.pronto),
          agendado: n(matterStats.agendado),
          publicado: n(matterStats.publicado),
          erro: n(matterStats.erro),
        },
      },
      recent: recent || [],
      recentMatters: recentMatters || [],
      scheduledMatters: scheduledMatters || [],
      nextAction,
      hasFacebook: connected,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { show };
