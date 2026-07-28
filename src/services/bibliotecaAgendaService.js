const db = require('../config/db');
const BibliotecaAgenda = require('../models/BibliotecaAgenda');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const AiMatters = require('../models/AiMatters');
const bibliotecaService = require('./bibliotecaService');
const materiaIaService = require('./materiaIaService');

const SLOT_MINUTES = 30;
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 22;
const DEFAULT_MAX_ITENS = 30;

/** Amanhã 00:00 America/Araguaina (UTC−3) como instante UTC. */
function startOfTomorrowAraguaina() {
  const now = new Date();
  const araguaiaMs = now.getTime() - 3 * 60 * 60 * 1000;
  const d = new Date(araguaiaMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate() + 1;
  return new Date(Date.UTC(y, m, day, 3, 0, 0, 0));
}

function buildSlots({ startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR, max = DEFAULT_MAX_ITENS } = {}) {
  const base = startOfTomorrowAraguaina();
  const slots = [];
  for (let h = startHour; h <= endHour; h += 1) {
    for (const min of [0, SLOT_MINUTES]) {
      if (h === endHour && min > 0) break;
      slots.push(new Date(base.getTime() + (h * 60 + min) * 60 * 1000));
      if (slots.length >= max) return slots;
    }
  }
  return slots;
}

function toDatetimeLocal(date) {
  const d = new Date(date);
  const ms = d.getTime() - 3 * 60 * 60 * 1000;
  const x = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

function parseProposedAt(runAt) {
  const raw = String(runAt || '').trim();
  if (!raw) return new Date(NaN);
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) return new Date(raw);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const sec = m[6] || '00';
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}-03:00`);
  }
  return new Date(raw);
}

function mapItem(row) {
  return {
    ...row,
    proposed_at_local: toDatetimeLocal(row.proposed_at),
    titulo: row.matter_titulo || row.post_titulo || 'Sem título',
    thumb: row.matter_imagem_url || row.post_thumbnail || null,
  };
}

async function listarAgenda(userId, { status = 'all' } = {}) {
  const itens = await BibliotecaAgenda.findByUser(userId, { status, limit: 120 });
  return (itens || []).map(mapItem);
}

/**
 * Puxa posts de site da biblioteca, gera matérias e pré-agenda amanhã de 30 em 30 min.
 */
async function montarAgendaAmanha({
  userId,
  facebookPageId,
  maxItens = DEFAULT_MAX_ITENS,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  somenteSites = true,
} = {}) {
  const page = await bibliotecaService.resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma Página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const slots = buildSlots({
    startHour: Number(startHour) || DEFAULT_START_HOUR,
    endHour: Number(endHour) || DEFAULT_END_HOUR,
    max: Math.min(48, Math.max(1, Number(maxItens) || DEFAULT_MAX_ITENS)),
  });

  const jaNaAgenda = new Set(
    (await BibliotecaAgenda.findActivePostIds(userId)).map((id) => Number(id))
  );

  let candidatos = await BibliotecaPosts.findCandidatosAutopilot(userId, Math.max(40, slots.length * 2));
  candidatos = await bibliotecaService.filtrarPostsNaoPublicados(userId, candidatos || []);
  candidatos = candidatos.filter((p) => {
    if (jaNaAgenda.has(Number(p.id))) return false;
    if (somenteSites && String(p.fonte_plataforma || '').toLowerCase() !== 'site') return false;
    return true;
  });

  if (candidatos.length < slots.length) {
    const extras = await db('biblioteca_posts as p')
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .leftJoin('ai_matters as m', 'm.id', 'p.matter_id')
      .where('p.user_id', userId)
      .whereNotNull('p.matter_id')
      .whereIn('m.status', ['rascunho', 'pronto'])
      .modify((qb) => {
        if (somenteSites) qb.andWhere('f.plataforma', 'site');
      })
      .orderByRaw('COALESCE(p.publicado_em, p.created_at) DESC')
      .limit(slots.length * 2)
      .select(
        'p.id',
        'p.fonte_id',
        'p.titulo',
        'p.url',
        'p.resumo',
        'p.thumbnail',
        'p.media_type',
        'p.status',
        'p.matter_id',
        'p.publicado_em',
        'p.created_at',
        'f.nome as fonte_nome',
        'f.plataforma as fonte_plataforma'
      );

    for (const e of extras || []) {
      if (jaNaAgenda.has(Number(e.id))) continue;
      if (candidatos.some((c) => Number(c.id) === Number(e.id))) continue;
      candidatos.push(e);
    }
  }

  if (!candidatos.length) {
    const err = new Error(
      'Nenhum post de site disponível na biblioteca. Escaneie fontes tipo Site e tente de novo.'
    );
    err.status = 422;
    throw err;
  }

  const criados = [];
  const erros = [];
  let slotIdx = 0;

  for (const post of candidatos) {
    if (slotIdx >= slots.length) break;
    try {
      let matterId = post.matter_id ? Number(post.matter_id) : null;
      if (matterId) {
        const matter = await AiMatters.findById(matterId);
        if (!matter || Number(matter.user_id) !== Number(userId)) matterId = null;
        else if (['publicado', 'agendado'].includes(String(matter.status))) continue;
      }

      if (!matterId) {
        const gerado = await bibliotecaService.gerarTextoDePost({
          userId,
          postId: post.id,
          facebookPageId: page.id,
          tipoPublicacao: 'foto',
          publicarAgora: false,
        });
        matterId = gerado.matter?.id || null;
        if (!matterId) throw new Error('Falha ao gerar matéria');
      }

      const proposedAt = slots[slotIdx];
      slotIdx += 1;

      try {
        const [id] = await BibliotecaAgenda.create({
          user_id: userId,
          facebook_page_id: page.id,
          post_id: post.id,
          matter_id: matterId,
          proposed_at: proposedAt,
          status: 'pendente',
        });
        criados.push({ id, postId: post.id, matterId, proposedAt });
        jaNaAgenda.add(Number(post.id));
      } catch (dupErr) {
        if (!/Duplicate|UNIQUE|ER_DUP/i.test(String(dupErr.message || ''))) throw dupErr;
        slotIdx -= 1;
      }
    } catch (err) {
      erros.push({ postId: post.id, erro: err.message });
    }
  }

  return {
    criados: criados.length,
    erros,
    slotsUsados: criados.length,
    dia: criados.length ? toDatetimeLocal(slots[0]).slice(0, 10) : null,
    itens: await listarAgenda(userId),
  };
}

async function getItemOwned(userId, id) {
  const item = await BibliotecaAgenda.findById(id);
  if (!item || Number(item.user_id) !== Number(userId)) {
    const err = new Error('Item da agenda não encontrado');
    err.status = 404;
    throw err;
  }
  return item;
}

async function atualizarHorario(userId, id, proposedAt) {
  const item = await getItemOwned(userId, id);
  if (item.status !== 'pendente') {
    const err = new Error('Só é possível alterar horário de itens pendentes');
    err.status = 400;
    throw err;
  }
  const parsed = parseProposedAt(proposedAt);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error('Data/hora inválida');
    err.status = 400;
    throw err;
  }
  await BibliotecaAgenda.update(item.id, { proposed_at: parsed });
  return { ok: true, itens: await listarAgenda(userId) };
}

async function confirmarAgendamento(userId, id) {
  const item = await getItemOwned(userId, id);
  if (!item.matter_id) {
    const err = new Error('Item sem matéria vinculada');
    err.status = 422;
    throw err;
  }
  if (item.status === 'confirmado' || item.status === 'publicado') {
    return { ok: true, already: true };
  }
  const runAt =
    item.proposed_at instanceof Date
      ? item.proposed_at.toISOString()
      : new Date(item.proposed_at).toISOString();
  const result = await materiaIaService.agendarMateria({
    userId,
    matterId: item.matter_id,
    runAt,
  });
  await BibliotecaAgenda.update(item.id, { status: 'confirmado' });
  return { ok: true, ...result };
}

async function publicarAgora(userId, id) {
  const item = await getItemOwned(userId, id);
  if (!item.matter_id) {
    const err = new Error('Item sem matéria vinculada');
    err.status = 422;
    throw err;
  }
  const pub = await materiaIaService.publicarMateria(userId, item.matter_id, {
    facebook_page_id: item.facebook_page_id,
    sync: true,
  });
  await BibliotecaAgenda.update(item.id, { status: 'publicado' });
  return { ok: true, publication: pub };
}

async function excluirItem(userId, id, { apagarMateria = false } = {}) {
  const item = await getItemOwned(userId, id);
  await BibliotecaAgenda.deleteById(item.id, userId);
  if (apagarMateria && item.matter_id) {
    try {
      await AiMatters.deleteByUser(item.matter_id, userId);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

async function acaoEmLote(userId, { ids = [], acao } = {}) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0);
  if (!list.length) {
    const err = new Error('Selecione ao menos um item');
    err.status = 400;
    throw err;
  }
  if (!['confirmar', 'publicar', 'excluir'].includes(String(acao))) {
    const err = new Error('Ação inválida (confirmar, publicar ou excluir)');
    err.status = 400;
    throw err;
  }

  const ok = [];
  const erros = [];
  for (const id of list) {
    try {
      if (acao === 'confirmar') await confirmarAgendamento(userId, id);
      else if (acao === 'publicar') await publicarAgora(userId, id);
      else await excluirItem(userId, id);
      ok.push(id);
    } catch (err) {
      erros.push({ id, erro: err.message });
    }
  }
  return { ok: ok.length, erros, itens: await listarAgenda(userId) };
}

module.exports = {
  listarAgenda,
  montarAgendaAmanha,
  atualizarHorario,
  confirmarAgendamento,
  publicarAgora,
  excluirItem,
  acaoEmLote,
  toDatetimeLocal,
  buildSlots,
  parseProposedAt,
};
