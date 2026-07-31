const db = require('../config/db');
const BibliotecaAgenda = require('../models/BibliotecaAgenda');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const AiMatters = require('../models/AiMatters');
const bibliotecaService = require('./bibliotecaService');
const materiaIaService = require('./materiaIaService');

const SLOT_MINUTES = 30;
const DEFAULT_START_HOUR = 7;
const DEFAULT_END_HOUR = 22;
const DEFAULT_MAX_ITENS = 20;
/** Evita timeout ao gerar muitas matérias com IA numa só requisição. */
const MAX_AI_GERACOES_POR_RODADA = 25;

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

function dayBoundsAmanha() {
  const start = startOfTomorrowAraguaina();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Todos os horários possíveis amanhã (7h–22h, de 30 em 30 min). */
function buildAllDaySlots({ startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR } = {}) {
  const base = startOfTomorrowAraguaina();
  const slots = [];
  for (let h = startHour; h <= endHour; h += 1) {
    for (const min of [0, SLOT_MINUTES]) {
      if (h === endHour && min > 0) break;
      slots.push(new Date(base.getTime() + (h * 60 + min) * 60 * 1000));
    }
  }
  return slots;
}

/**
 * Interpreta valor vindo do banco. O driver já devolve Date no fuso do processo;
 * reconverter aqui causava deslocamento de horas (09:00 virava 12:00).
 */
function asAgendaDate(value) {
  if (value == null || value === '') return new Date(NaN);
  if (value instanceof Date) return value;
  return parseProposedAt(value);
}

/** Chave estável do horário na TZ Araguaina: YYYY-MM-DDTHH:mm */
function chaveHorario(date) {
  return toDatetimeLocal(asAgendaDate(date)).slice(0, 16);
}

function diaAmanhaKey() {
  return toDatetimeLocal(startOfTomorrowAraguaina()).slice(0, 10);
}

/**
 * Horários livres amanhã.
 * - `ocupadosKeys`: Set de chaves já usadas (confirmado/pendente/publicado) — evita overbooking
 * - `afterDate`: se informado, só slots depois desse horário (continuidade)
 */
function buildSlots({
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  max = DEFAULT_MAX_ITENS,
  afterDate = null,
  ocupadosKeys = null,
} = {}) {
  const all = buildAllDaySlots({ startHour, endHour });
  const afterMs = afterDate ? new Date(afterDate).getTime() : 0;
  const ocupados =
    ocupadosKeys instanceof Set
      ? ocupadosKeys
      : new Set(Array.isArray(ocupadosKeys) ? ocupadosKeys : []);
  let free = all.filter((s) => {
    if (ocupados.size && ocupados.has(chaveHorario(s))) return false;
    if (Number.isFinite(afterMs) && afterMs > 0 && s.getTime() <= afterMs) return false;
    return true;
  });
  // Se afterDate falhou por fuso mas ocupadosKeys existe, free já está correto só pelos ocupados
  if (!free.length && ocupados.size) {
    free = all.filter((s) => !ocupados.has(chaveHorario(s)));
  }
  const lim = Math.min(48, Math.max(1, Number(max) || DEFAULT_MAX_ITENS));
  return free.slice(0, lim);
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
  let thumb = row.matter_imagem_url || row.post_thumbnail || null;
  if (row.matter_imagem_path) {
    thumb = `/media/${String(row.matter_imagem_path).replace(/\\/g, '/')}`;
  }
  const st = String(row.status || '');
  const matterSt = String(row.matter_status || '');
  // Horário da AGENDA (proposed_at) é a fonte da verdade — não substituir por matter_scheduled_at
  const horario = asAgendaDate(row.proposed_at);
  const matchedKeyword = String(row.matched_keyword || '').trim() || null;
  return {
    ...row,
    proposed_at: Number.isFinite(horario.getTime()) ? horario : row.proposed_at,
    proposed_at_local: toDatetimeLocal(
      Number.isFinite(horario.getTime()) ? horario : row.proposed_at
    ),
    titulo: row.matter_titulo || row.post_titulo || 'Sem título',
    thumb,
    matched_keyword: matchedKeyword,
    palavra_chave: matchedKeyword,
    is_viral_origem: Boolean(row.source_matter_id),
    source_matter_id: row.source_matter_id || null,
    source_matter_titulo: row.source_matter_titulo || null,
    source_page_name: row.source_page_name || null,
    ui_status:
      st === 'confirmado'
        ? 'agendada'
        : st === 'publicado' || matterSt === 'publicado'
          ? 'publicado'
          : st || 'pendente',
    can_edit_arte:
      Boolean(row.matter_id) &&
      !['publicado'].includes(st) &&
      !['publicado'].includes(matterSt),
  };
}

/**
 * Preenche matched_keyword em itens antigos (antes da coluna existir)
 * usando as palavras-chave salvas do usuário.
 */
async function enriquecerMatchedKeywords(userId, itens) {
  const lista = Array.isArray(itens) ? itens : [];
  const faltando = lista.filter((r) => !String(r.matched_keyword || '').trim());
  if (!faltando.length) return lista;

  const BibliotecaAlertas = require('../models/BibliotecaAlertas');
  const Users = require('../models/Users');
  const user = await Users.findById(userId);
  const keywords = BibliotecaAlertas.parseKeywords(user?.biblioteca_alertas_keywords);
  if (!keywords.length) return lista;

  const keywordsStr = keywords.join(', ');
  const updates = [];
  for (const row of faltando) {
    const hits = BibliotecaAlertas.findMatchingKeywords(row, keywordsStr);
    if (!hits.length) continue;
    const hit = hits.slice(0, 3).join(', ').slice(0, 60);
    row.matched_keyword = hit;
    updates.push(BibliotecaAgenda.update(row.id, { matched_keyword: hit }));
  }
  if (updates.length) {
    await Promise.all(updates).catch((err) => {
      console.warn('[agenda] backfill matched_keyword:', err.message);
    });
  }
  return lista;
}

/** Alinha status da agenda com a matéria. Horário: agenda é a fonte da verdade. */
async function sincronizarComMaterias(userId, itens) {
  const lista = Array.isArray(itens) ? itens : [];
  for (const row of lista) {
    const agendaSt = String(row.status || '');
    if (!row.matter_id) {
      if (agendaSt === 'confirmado') {
        await BibliotecaAgenda.update(row.id, { status: 'pendente' });
        row.status = 'pendente';
      }
      continue;
    }
    const matterSt = String(row.matter_status || '');
    try {
      if (matterSt === 'publicado' && agendaSt !== 'publicado') {
        await BibliotecaAgenda.update(row.id, { status: 'publicado' });
        row.status = 'publicado';
      }
      // Pré-agendado NÃO pode aparecer como agendado em /minhas-materias.
      // Só confirmar agenda (ou Agendar no editor) cria scheduled_at/job.
      if (matterSt === 'agendado' && agendaSt === 'pendente') {
        try {
          await db('ai_matters').where({ id: row.matter_id }).update({
            status: 'pronto',
            scheduled_at: null,
            updated_at: db.fn.now(),
          });
          await db('ai_fila_jobs')
            .where({ matter_id: row.matter_id, status: 'pendente' })
            .update({
              status: 'cancelado',
              erro: 'Agenda pré-agendada — só agenda ao Confirmar',
            });
          row.matter_status = 'pronto';
          row.matter_scheduled_at = null;
        } catch (err) {
          console.warn(`[agenda] cancelar pré-agendada #${row.matter_id}:`, err.message);
        }
      }
      // Agenda confirmada é a fonte do horário.
      if (
        (row.status === 'confirmado' || agendaSt === 'confirmado') &&
        row.matter_id &&
        row.proposed_at &&
        (row.matter_status !== 'agendado' ||
          !row.matter_scheduled_at ||
          Math.abs(new Date(row.proposed_at).getTime() - new Date(row.matter_scheduled_at).getTime()) > 60_000)
      ) {
        const a = new Date(row.proposed_at).getTime();
        if (Number.isFinite(a)) {
          try {
            const result = await materiaIaService.agendarMateria({
              userId,
              matterId: row.matter_id,
              runAt: new Date(row.proposed_at).toISOString(),
            });
            if (result?.runAt && new Date(result.runAt).getTime() !== a) {
              await BibliotecaAgenda.update(row.id, { proposed_at: result.runAt });
              row.proposed_at = result.runAt;
            }
            row.matter_scheduled_at = result?.runAt || row.proposed_at;
            row.matter_status = 'agendado';
          } catch {
            /* mantém horário da agenda mesmo se a fila falhar */
          }
        }
      }
    } catch {
      /* não bloqueia listagem */
    }
  }
  return lista;
}

/** Meia-noite Araguaina (UTC−3) do dia YYYY-MM-DD. */
function startOfDayAraguaina(dayKey) {
  const m = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return startOfTomorrowAraguaina();
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 3, 0, 0, 0));
}

/** Slots 7h–22h de um dia específico (chave local Araguaina). */
function buildAllDaySlotsForDay(
  dayKey,
  { startHour = DEFAULT_START_HOUR, endHour = DEFAULT_END_HOUR } = {}
) {
  const base = startOfDayAraguaina(dayKey);
  const slots = [];
  for (let h = startHour; h <= endHour; h += 1) {
    for (const min of [0, SLOT_MINUTES]) {
      if (h === endHour && min > 0) break;
      slots.push(new Date(base.getTime() + (h * 60 + min) * 60 * 1000));
    }
  }
  return slots;
}

/** Itens ativos do dia (filtra por chave local — evita erro de fuso no WHERE). */
async function itensAgendaDoDia(userId, dayKey = null) {
  const day = dayKey || diaAmanhaKey();
  const rows = await db(BibliotecaAgenda.table)
    .where({ user_id: userId })
    .whereNotIn('status', ['cancelado'])
    .select('id', 'proposed_at', 'status', 'post_id', 'matter_id');
  return (rows || [])
    .map((r) => ({ ...r, proposed_at: asAgendaDate(r.proposed_at) }))
    .filter((r) => Number.isFinite(r.proposed_at.getTime()))
    .filter((r) => chaveHorario(r.proposed_at).slice(0, 10) === day);
}

/** Último horário já ocupado amanhã (pendente, confirmado ou publicado). */
async function ultimoHorarioOcupadoAmanha(userId) {
  const itens = await itensAgendaDoDia(userId);
  if (!itens.length) return null;
  let max = null;
  for (const r of itens) {
    const t = r.proposed_at.getTime();
    if (max == null || t > max) max = t;
  }
  return max != null ? new Date(max) : null;
}

/** Dias com itens pendente/confirmado (compacta todos, não só hoje/amanhã). */
async function diasAtivosAgenda(userId) {
  const rows = await db(BibliotecaAgenda.table)
    .where({ user_id: userId })
    .whereIn('status', ['pendente', 'confirmado'])
    .select('proposed_at');
  const days = new Set();
  for (const r of rows || []) {
    if (!r.proposed_at) continue;
    const key = chaveHorario(asAgendaDate(r.proposed_at));
    if (key) days.add(key.slice(0, 10));
  }
  return [...days];
}

/**
 * Compacta pendentes + confirmados do dia em horários contínuos de 30 em 30 min.
 * Ex.: 08:00, 08:30, 10:30 → 08:00, 08:30, 09:00
 *
 * Não pula slots por causa de itens já "publicado" — a aba Agendada deve ficar
 * contínua; publicados ficam na outra aba e não devem abrir buraco na fila.
 */
async function compactarHorariosDoDia(userId, { dayKey = null } = {}) {
  const day = dayKey || diaAmanhaKey();
  const todos = await itensAgendaDoDia(userId, day);
  const itens = todos
    .filter((r) => r.status === 'pendente' || r.status === 'confirmado')
    .sort((a, b) => a.proposed_at.getTime() - b.proposed_at.getTime());
  if (itens.length < 1) return { ajustados: 0, day };

  const slots = buildAllDaySlotsForDay(day);
  if (!slots.length) return { ajustados: 0, day };

  const firstMs = itens[0].proposed_at.getTime();
  let startIdx = 0;
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i].getTime() <= firstMs) startIdx = i;
    else break;
  }

  // Garante que todos cabem na janela 7h–22h
  if (startIdx + itens.length > slots.length) {
    startIdx = Math.max(0, slots.length - itens.length);
  }

  let ajustados = 0;
  const antes = itens.map((r) => chaveHorario(r.proposed_at));
  for (let i = 0; i < itens.length; i += 1) {
    const slot = slots[startIdx + i];
    if (!slot) {
      console.warn(
        `[agenda] compactar user #${userId} ${day}: sem slot para item #${itens[i].id}`
      );
      break;
    }
    const atualKey = chaveHorario(itens[i].proposed_at);
    const novoKey = chaveHorario(slot);
    if (atualKey === novoKey) continue;

    // Grava o Date direto: o driver serializa/lê no mesmo fuso, mantendo o round-trip estável
    await BibliotecaAgenda.update(itens[i].id, { proposed_at: slot });
    itens[i].proposed_at = slot;
    // Só sincroniza a fila da matéria se o item JÁ foi confirmado.
    // Chamar agendarMateria em "pendente" vira a matéria em "agendado" e a UI
    // mostra AGENDADA / sincronizarComMaterias promove a agenda — sem o usuário confirmar.
    if (itens[i].status === 'confirmado' && itens[i].matter_id) {
      try {
        const result = await materiaIaService.agendarMateria({
          userId,
          matterId: itens[i].matter_id,
          runAt: slot.toISOString(),
        });
        if (result?.runAt && new Date(result.runAt).getTime() !== slot.getTime()) {
          await BibliotecaAgenda.update(itens[i].id, { proposed_at: result.runAt });
          itens[i].proposed_at = result.runAt;
        }
      } catch (err) {
        console.warn(`[agenda] sync matéria #${itens[i].matter_id} → ${novoKey}:`, err.message);
      }
    }
    ajustados += 1;
  }
  if (ajustados > 0) {
    const depois = itens.map((r) => chaveHorario(r.proposed_at));
    console.log(
      `[agenda] compactar user #${userId} ${day}: ${ajustados} ajuste(s)`,
      `\n  antes: ${antes.join(', ')}`,
      `\n  depois: ${depois.join(', ')}`
    );
  } else {
    console.log(
      `[agenda] compactar user #${userId} ${day}: ok (já contínuo) ${antes.join(', ')}`
    );
  }
  return { ajustados, day, antes, depois: itens.map((r) => chaveHorario(r.proposed_at)) };
}

/** Serializa compactações do mesmo usuário (a página dispara várias em paralelo). */
const compactacoesEmCurso = new Map();

/** Compacta todos os dias com itens abertos na agenda. */
async function compactarHorariosAbertos(userId) {
  const emCurso = compactacoesEmCurso.get(userId);
  if (emCurso) return emCurso;

  const run = (async () => {
    let days = await diasAtivosAgenda(userId);
    if (!days.length) {
      days = [diaHojeKey(), diaAmanhaKey()];
    }
    let total = 0;
    const detalhes = [];
    for (const day of days) {
      const r = await compactarHorariosDoDia(userId, { dayKey: day });
      total += r.ajustados || 0;
      if (r.antes) {
        detalhes.push({
          day,
          ajustados: r.ajustados || 0,
          antes: r.antes,
          depois: r.depois,
        });
      }
    }
    return { ajustados: total, days, detalhes };
  })();

  compactacoesEmCurso.set(userId, run);
  try {
    return await run;
  } finally {
    compactacoesEmCurso.delete(userId);
  }
}

/** @deprecated use compactarHorariosDoDia — mantido como alias */
async function repararHorariosSobrepostos(userId) {
  return compactarHorariosAbertos(userId);
}

async function listarAgenda(userId, { status = 'all', aba = null, reparar = true } = {}) {
  const tab = String(aba || status || 'agendada').toLowerCase();
  let statuses = null;
  let order = 'asc';
  let filterStatus = status;

  if (tab === 'agendada' || tab === 'agendadas' || tab === 'pendente') {
    statuses = ['pendente', 'confirmado'];
    order = 'asc';
    filterStatus = null;
  } else if (tab === 'publicadas' || tab === 'publicado') {
    statuses = ['publicado'];
    order = 'desc';
    filterStatus = null;
  } else if (tab === 'confirmado') {
    filterStatus = 'confirmado';
  } else if (tab === 'all') {
    filterStatus = 'all';
  }

  const fetchItens = () =>
    BibliotecaAgenda.findByUser(userId, {
      status: filterStatus,
      statuses,
      limit: 120,
      order,
    });

  let itens = await fetchItens();
  await sincronizarComMaterias(userId, itens || []);

  if (reparar) {
    try {
      const r = await compactarHorariosAbertos(userId);
      if (r.ajustados > 0) itens = await fetchItens();
    } catch (err) {
      console.warn('[agenda] compactar:', err.message);
    }
  }

  // Itens antigos sem matched_keyword: deriva das palavras-chave atuais e grava
  itens = await enriquecerMatchedKeywords(userId, itens || []);

  return (itens || []).map(mapItem);
}

async function contagensAgenda(userId) {
  const base = await BibliotecaAgenda.countByStatus(userId);
  let viralizadas = 0;
  try {
    viralizadas = await AiMatters.countViralizadasDaConta(userId);
    const usadas = await BibliotecaAgenda.findPublishedSourceMatterIds(userId);
    if (usadas.length) {
      viralizadas = Math.max(0, Number(viralizadas) - usadas.length);
    }
  } catch (err) {
    console.warn('[agenda] contagem viralizadas:', err.message);
    try {
      viralizadas = await AiMatters.countByUserWithPub(userId, { status: 'viralizou' });
    } catch {
      /* ignore */
    }
  }
  return { ...base, viralizadas: Number(viralizadas) || 0 };
}

/**
 * Matérias que viralizaram em QUALQUER Página da conta (Apocalipse, JM, etc.).
 * Sincroniza engajamento antes — sem isso a lista fica vazia mesmo com posts bons no FB.
 */
async function listarViralizadas(userId, { limit = 40, sync = true } = {}) {
  if (sync) {
    try {
      await materiaIaService.sincronizarEngajamentoRecentes(userId, {
        limit: 45,
        concurrency: 2,
      });
    } catch (err) {
      console.warn('[agenda] sync engajamento viralizadas:', err.message);
    }
  }

  const lim = Math.min(80, Math.max(1, Number(limit) || 40));
  let rows = [];
  try {
    rows = await AiMatters.findViralizadasDaConta(userId, { limit: lim });
  } catch (err) {
    console.warn('[agenda] findViralizadasDaConta:', err.message);
    rows = await AiMatters.findByUserWithPub(userId, { status: 'viralizou', limit: lim });
  }

  let usadas = [];
  let jaPublicadas = [];
  try {
    [usadas, jaPublicadas] = await Promise.all([
      BibliotecaAgenda.findActiveSourceMatterIds(userId),
      BibliotecaAgenda.findPublishedSourceMatterIds(userId),
    ]);
  } catch (err) {
    // Coluna source_matter_id pode ainda não existir se a migration não rodou
    console.warn('[agenda] source_matter_id:', err.message);
  }
  const usadasSet = new Set((usadas || []).map((id) => Number(id)));
  const publicadasSet = new Set((jaPublicadas || []).map((id) => Number(id)));

  // Já publicou a variação → some da aba (foi usada naquele perfil)
  const filtradas = (rows || []).filter((r) => !publicadasSet.has(Number(r.id)));

  // Busca mais se o filtro tirou muitas (pool era limitado)
  if (filtradas.length < lim && publicadasSet.size > 0) {
    try {
      const mais = await AiMatters.findViralizadasDaConta(userId, {
        limit: Math.min(80, lim + publicadasSet.size),
      });
      const visto = new Set(filtradas.map((r) => Number(r.id)));
      for (const r of mais || []) {
        const id = Number(r.id);
        if (visto.has(id) || publicadasSet.has(id)) continue;
        filtradas.push(r);
        visto.add(id);
        if (filtradas.length >= lim) break;
      }
    } catch {
      /* mantém filtradas */
    }
  }

  return filtradas.slice(0, lim).map((r) => {
    let thumb = r.imagem_url || null;
    if (r.imagem_path) {
      thumb = `/media/${String(r.imagem_path).replace(/\\/g, '/')}`;
    }
    const likes = r.pub_fb_likes != null ? Number(r.pub_fb_likes) : null;
    const comments = r.pub_fb_comments != null ? Number(r.pub_fb_comments) : null;
    const views = r.pub_fb_views != null ? Number(r.pub_fb_views) : null;
    const shares = r.pub_fb_shares != null ? Number(r.pub_fb_shares) : null;
    const score =
      (Number(likes) || 0) +
      (Number(comments) || 0) * 3 +
      (Number(shares) || 0) * 5 +
      Math.min(Number(views) || 0, 5000) / 50;
    let viralLabel = 'Bom';
    if (score >= 180 || (likes || 0) >= 80 || (comments || 0) >= 25) {
      viralLabel = 'Viralizou';
    }
    return {
      id: r.id,
      titulo: r.titulo || 'Sem título',
      page_name: r.page_name || null,
      facebook_page_id: r.facebook_page_id || null,
      tipo_publicacao: r.tipo_publicacao || 'foto',
      thumb,
      fb_post_url: r.pub_fb_post_url || null,
      likes,
      comments,
      views,
      shares,
      viral_label: viralLabel,
      published_at: r.published_at || r.pub_published_at || null,
      ja_na_agenda: usadasSet.has(Number(r.id)),
    };
  });
}

/**
 * Gera variação anti-plágio (estilo/marca do perfil logado) e pré-agenda.
 * A matéria original permanece; a nova vai para a página escolhida.
 */
async function agendarViralizada({
  userId,
  origemMatterId,
  facebookPageId,
  proposedAt = null,
  confirmar = false,
} = {}) {
  const origemId = Number(origemMatterId);
  if (!Number.isInteger(origemId) || origemId < 1) {
    const err = new Error('Matéria viral inválida');
    err.status = 400;
    throw err;
  }

  const origem = await AiMatters.findById(origemId);
  if (!origem) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const acessivel = await AiMatters.matterAcessivelPelaConta(userId, origem);
  if (!acessivel) {
    const err = new Error('Matéria não encontrada nesta conta');
    err.status = 404;
    throw err;
  }

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  let page = null;
  if (facebookPageId) {
    page = await resolvePageForUser(userId, facebookPageId);
  }
  if (!page) page = await defaultPageForUser(userId);
  if (!page) {
    const err = new Error('Selecione uma Página do Facebook em /paginas');
    err.status = 400;
    throw err;
  }

  // Evita agendar a mesma origem de novo para a mesma página
  const ja = await db('biblioteca_agenda')
    .where({
      user_id: userId,
      source_matter_id: origemId,
      facebook_page_id: page.id,
    })
    .whereNotIn('status', ['cancelado'])
    .first();
  if (ja) {
    const err = new Error(
      'Essa viralizada já está na agenda desta Página. Exclua o item ou escolha outra Página.'
    );
    err.status = 409;
    throw err;
  }

  // Mesma página da original → ainda reescreve (anti-plágio), mas avisa
  const mesmaPagina = Number(origem.facebook_page_id) === Number(page.id);

  const gerado = await materiaIaService.gerarVariacaoDeMateria({
    userId,
    matterId: origemId,
    facebookPageId: page.id,
    tipoPublicacao: origem.tipo_publicacao === 'texto' ? 'texto' : 'foto',
  });
  const novaMatter = gerado.matter || gerado.payload?.matter || null;
  const matterId = novaMatter?.id || null;
  if (!matterId) {
    const err = new Error('Falha ao gerar a variação da matéria viral');
    err.status = 502;
    throw err;
  }

  let when = proposedAt ? parseProposedAt(proposedAt) : null;
  if (!when || Number.isNaN(when.getTime())) {
    const slots = buildSlots({
      max: 1,
      ocupadosKeys: await (async () => {
        const amanhaItens = await itensAgendaDoDia(userId);
        return new Set(
          (amanhaItens || []).map((i) => chaveHorario(i.proposed_at)).filter(Boolean)
        );
      })(),
    });
    when = slots[0] || new Date(Date.now() + 60 * 60 * 1000);
  }
  if (when.getTime() < Date.now() + 5 * 60_000) {
    const err = new Error(
      'Horário muito próximo ou no passado. Escolha um horário com pelo menos 5 minutos de antecedência.'
    );
    err.status = 400;
    throw err;
  }

  const [agendaId] = await BibliotecaAgenda.create({
    user_id: userId,
    facebook_page_id: page.id,
    post_id: null,
    matter_id: matterId,
    source_matter_id: origemId,
    proposed_at: when,
    status: 'pendente',
    matched_keyword: 'viralizada',
  });

  let confirmado = null;
  if (confirmar) {
    confirmado = await confirmarAgendamento(userId, agendaId);
  }

  return {
    agendaId,
    matterId,
    origemMatterId: origemId,
    facebookPageId: page.id,
    pageName: page.page_name,
    proposedAt: when,
    proposed_at_local: toDatetimeLocal(when),
    mesmaPagina,
    angulo: gerado.angulo || null,
    titulo: novaMatter?.titulo || null,
    confirmado: Boolean(confirmado),
  };
}

/**
 * Puxa posts de site da biblioteca, gera matérias e pré-agenda amanhã de 30 em 30 min.
 * Novos itens começam no próximo slot após o último já agendado/confirmado.
 */
async function montarAgendaAmanha({
  userId,
  facebookPageId,
  maxItens = DEFAULT_MAX_ITENS,
  startHour = DEFAULT_START_HOUR,
  endHour = DEFAULT_END_HOUR,
  somenteSites = true,
  usarKeywords = false,
  keywords = null,
} = {}) {
  const page = await bibliotecaService.resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma Página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const BibliotecaAlertas = require('../models/BibliotecaAlertas');
  let keywordsList = BibliotecaAlertas.parseKeywords(keywords);
  if (usarKeywords && !keywordsList.length) {
    const Users = require('../models/Users');
    const user = await Users.findById(userId);
    keywordsList = BibliotecaAlertas.parseKeywords(user?.biblioteca_alertas_keywords);
  }
  if (usarKeywords && !keywordsList.length) {
    const err = new Error(
      'Nenhuma palavra-chave salva. Cadastre em Biblioteca → Palavras-chave e tente de novo.'
    );
    err.status = 400;
    throw err;
  }
  const keywordsFiltro = usarKeywords ? keywordsList.join(', ') : null;

  // Com filtro: remove itens abertos fora das palavras-chave ANTES de checar slots
  // (o auto-preenchimento antigo enchia a agenda sem filtro).
  let removidosSemKw = 0;
  if (keywordsFiltro) {
    const limpeza = await limparItensSemPalavraChave(userId, {
      keywords: keywordsFiltro,
      statuses: ['pendente', 'confirmado'],
      compactar: true,
    });
    removidosSemKw = limpeza.removidos || 0;
  }

  const maxPedidos = Math.min(48, Math.max(1, Number(maxItens) || DEFAULT_MAX_ITENS));
  // Fecha buracos (ex. 08:30 → 10:30) antes de encaixar novos
  await compactarHorariosDoDia(userId, { dayKey: diaAmanhaKey() });

  const itensDia = await itensAgendaDoDia(userId);
  const ocupadosKeys = new Set(itensDia.map((r) => chaveHorario(r.proposed_at)));
  const ultimoOcupado = await ultimoHorarioOcupadoAmanha(userId);
  // Prefere gaps livres no meio do dia; se afterDate bloquear tudo, buildSlots cai nos livres por ocupadosKeys
  const slots = buildSlots({
    startHour: Number(startHour) || DEFAULT_START_HOUR,
    endHour: Number(endHour) || DEFAULT_END_HOUR,
    max: maxPedidos,
    afterDate: null,
    ocupadosKeys,
  });

  if (!slots.length) {
    if (removidosSemKw > 0) {
      return {
        criados: 0,
        erros: [],
        removidosSemKw,
        filtroKeywords: true,
        keywordsUsadas: keywordsList.length,
        mensagem: `Removidos ${removidosSemKw} item(ns) fora das palavras-chave. Sem horários livres restantes — rode de novo ou exclua mais itens.`,
        itens: await listarAgenda(userId, { aba: 'agendada' }),
      };
    }
    const ate = ultimoOcupado ? toDatetimeLocal(ultimoOcupado).replace('T', ' ') : null;
    const err = new Error(
      ate
        ? `Agenda de amanhã já está cheia até ${ate} (janela ${startHour}h–${endHour}h). Exclua algum item ou use “Reorganizar 30 em 30”.`
        : `Não há horários livres amanhã na janela ${startHour}h–${endHour}h.`
    );
    err.status = 422;
    throw err;
  }

  const jaNaAgenda = new Set(
    (await BibliotecaAgenda.findActivePostIds(userId)).map((id) => Number(id))
  );

  // Com filtro de palavras-chave, busca pool maior — muitos posts não vão bater
  const poolMult = keywordsFiltro ? 10 : 2;
  let candidatos = await BibliotecaPosts.findCandidatosAutopilot(
    userId,
    Math.max(80, slots.length * poolMult)
  );
  candidatos = await bibliotecaService.filtrarPostsNaoPublicados(userId, candidatos || []);
  candidatos = candidatos.filter((p) => {
    if (jaNaAgenda.has(Number(p.id))) return false;
    if (somenteSites && String(p.fonte_plataforma || '').toLowerCase() !== 'site') return false;
    return true;
  });

  if (keywordsFiltro || candidatos.length < slots.length) {
    const extras = await db('biblioteca_posts as p')
      .leftJoin('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
      .leftJoin('ai_matters as m', 'm.id', 'p.matter_id')
      .where('p.user_id', userId)
      .modify((qb) => {
        if (somenteSites) qb.andWhere('f.plataforma', 'site');
        if (keywordsFiltro) {
          // Pool amplo (com ou sem matéria) para o filtro em JS
          qb.whereIn('p.status', ['novo', 'visto', 'usado']);
        } else {
          qb.whereNotNull('p.matter_id').whereIn('m.status', ['rascunho', 'pronto']);
        }
      })
      .orderByRaw('COALESCE(p.publicado_em, p.created_at) DESC')
      .limit(keywordsFiltro ? Math.max(300, slots.length * 15) : slots.length * 3)
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

  candidatos = await bibliotecaService.filtrarPostsNaoPublicados(userId, candidatos || []);

  if (keywordsFiltro) {
    candidatos = BibliotecaAlertas.filterByKeywords(candidatos, keywordsFiltro);
  }

  // Prefere posts que já têm matéria (mais rápido; evita timeout na rodada)
  candidatos.sort((a, b) => {
    const am = a.matter_id ? 0 : 1;
    const bm = b.matter_id ? 0 : 1;
    if (am !== bm) return am - bm;
    return 0;
  });

  if (!candidatos.length) {
    const err = new Error(
      keywordsFiltro
        ? 'Nenhum post de site bate com suas palavras-chave da Biblioteca. Escaneie mais fontes, ajuste as palavras-chave ou desmarque o filtro.'
        : 'Nenhum post de site disponível na biblioteca para novos horários. Escaneie fontes tipo Site (ou exclua itens da agenda) e tente de novo.'
    );
    err.status = 422;
    throw err;
  }

  const criados = [];
  const erros = [];
  let slotIdx = 0;
  let aiGens = 0;

  for (const post of candidatos) {
    if (slotIdx >= slots.length) break;

    // Dupla checagem: nunca agenda sem match quando o filtro está ligado
    let matchedKeyword = null;
    if (keywordsFiltro) {
      const matchedHits = BibliotecaAlertas.findMatchingKeywords(post, keywordsFiltro);
      if (!matchedHits.length) continue;
      matchedKeyword = matchedHits.slice(0, 3).join(', ').slice(0, 60);
    }

    try {
      let matterId = post.matter_id ? Number(post.matter_id) : null;
      if (matterId) {
        const matter = await AiMatters.findById(matterId);
        if (!matter || Number(matter.user_id) !== Number(userId)) matterId = null;
        else if (['publicado', 'agendado'].includes(String(matter.status))) continue;
      }

      if (!matterId) {
        if (aiGens >= MAX_AI_GERACOES_POR_RODADA) {
          erros.push({
            postId: post.id,
            erro: `Limite de ${MAX_AI_GERACOES_POR_RODADA} gerações com IA nesta rodada — rode de novo para continuar.`,
          });
          continue;
        }
        const gerado = await bibliotecaService.gerarTextoDePost({
          userId,
          postId: post.id,
          facebookPageId: page.id,
          tipoPublicacao: 'foto',
          publicarAgora: false,
        });
        matterId = gerado.matter?.id || null;
        if (!matterId) throw new Error('Falha ao gerar matéria');
        aiGens += 1;
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
          matched_keyword: matchedKeyword || null,
        });
        criados.push({
          id,
          postId: post.id,
          matterId,
          proposedAt,
          matched_keyword: matchedKeyword || null,
        });
        jaNaAgenda.add(Number(post.id));
      } catch (dupErr) {
        if (!/Duplicate|UNIQUE|ER_DUP/i.test(String(dupErr.message || ''))) throw dupErr;
        // Post já na agenda — libera o slot para o próximo candidato
        slotIdx -= 1;
      }
    } catch (err) {
      erros.push({ postId: post.id, erro: err.message || 'Falha ao processar post' });
    }
  }

  if (!criados.length) {
    if (removidosSemKw > 0) {
      return {
        criados: 0,
        erros,
        removidosSemKw,
        filtroKeywords: Boolean(keywordsFiltro),
        keywordsUsadas: keywordsList.length,
        mensagem: `Removidos ${removidosSemKw} item(ns) fora das palavras-chave. Nenhum post novo encaixado nesta rodada — tente de novo.`,
        itens: await listarAgenda(userId, { aba: 'agendada' }),
      };
    }
    const detalhe = erros[0]?.erro || 'não foi possível gerar ou encaixar matérias';
    const err = new Error(
      `Nenhum item foi pré-agendado (${detalhe}). Verifique posts disponíveis e tente de novo.`
    );
    err.status = 422;
    throw err;
  }

  const primeiro = criados[0].proposedAt;
  const ultimo = criados[criados.length - 1].proposedAt;

  return {
    criados: criados.length,
    erros,
    slotsUsados: criados.length,
    removidosSemKw,
    continuidade: ultimoOcupado ? toDatetimeLocal(ultimoOcupado) : null,
    de: toDatetimeLocal(primeiro),
    ate: toDatetimeLocal(ultimo),
    dia: toDatetimeLocal(primeiro).slice(0, 10),
    filtroKeywords: Boolean(keywordsFiltro),
    keywordsUsadas: keywordsList.length,
    itens: await listarAgenda(userId, { aba: 'agendada' }),
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
  if (!['pendente', 'confirmado'].includes(String(item.status || ''))) {
    const err = new Error('Só é possível alterar horário de itens pré-agendados ou confirmados');
    err.status = 400;
    throw err;
  }
  const parsed = parseProposedAt(proposedAt);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error('Data/hora inválida');
    err.status = 400;
    throw err;
  }
  // Nunca no passado (margem de 1 minuto)
  if (parsed.getTime() < Date.now() - 60_000) {
    const err = new Error('Escolha uma data e hora a partir de agora — não é possível agendar no passado');
    err.status = 400;
    throw err;
  }
  await BibliotecaAgenda.update(item.id, { proposed_at: parsed });

  // Confirmado: atualiza também o job da matéria (scheduled_at)
  if (item.status === 'confirmado' && item.matter_id) {
    const result = await materiaIaService.agendarMateria({
      userId,
      matterId: item.matter_id,
      runAt: parsed.toISOString(),
    });
    if (result?.runAt && new Date(result.runAt).getTime() !== parsed.getTime()) {
      await BibliotecaAgenda.update(item.id, { proposed_at: result.runAt });
      return {
        ok: true,
        proposed_at: result.runAt,
        proposed_at_local: toDatetimeLocal(result.runAt),
        status: item.status,
        ajustado: true,
      };
    }
  }

  return {
    ok: true,
    proposed_at: parsed,
    proposed_at_local: toDatetimeLocal(parsed),
    status: item.status,
  };
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
  const runAtDate =
    item.proposed_at instanceof Date ? item.proposed_at : new Date(item.proposed_at);
  if (Number.isNaN(runAtDate.getTime())) {
    const err = new Error('Horário inválido neste item — ajuste a data/hora antes de confirmar');
    err.status = 400;
    throw err;
  }
  // Evita “agendar pra agora” por engano (ex.: 15:42 quando são 15:41)
  if (runAtDate.getTime() < Date.now() + 5 * 60_000) {
    const err = new Error(
      'Horário muito próximo ou no passado. Ajuste a data/hora (ex.: amanhã 7h–22h) e confirme de novo.'
    );
    err.status = 400;
    throw err;
  }
  const runAt = runAtDate.toISOString();
  const result = await materiaIaService.agendarMateria({
    userId,
    matterId: item.matter_id,
    runAt,
  });
  const finalRunAt = result?.runAt ? new Date(result.runAt) : runAtDate;
  await BibliotecaAgenda.update(item.id, { status: 'confirmado', proposed_at: finalRunAt });
  return { ok: true, ...result };
}

async function sincronizarAgendamentoDaMateria(userId, matterId, runAt) {
  const id = Number(matterId || 0);
  if (!id || !runAt) return { ok: true, synced: false };
  const item = await db(BibliotecaAgenda.table)
    .where({ user_id: userId, matter_id: id })
    .whereNotIn('status', ['cancelado', 'publicado'])
    .orderBy('id', 'desc')
    .first();
  if (!item) return { ok: true, synced: false };

  const parsed = runAt instanceof Date ? runAt : new Date(runAt);
  if (Number.isNaN(parsed.getTime())) return { ok: true, synced: false };

  await BibliotecaAgenda.update(item.id, {
    proposed_at: parsed,
    status: 'confirmado',
  });
  return { ok: true, synced: true, agendaId: item.id, proposed_at: parsed };
}

async function cancelarAgendamentosPendentesDaBiblioteca(userId) {
  const rows = await db(`${BibliotecaAgenda.table} as a`)
    .join('ai_matters as m', 'm.id', 'a.matter_id')
    .where('a.user_id', userId)
    .where('a.status', 'pendente')
    .where('m.status', 'agendado')
    .select('a.id as agenda_id', 'm.id as matter_id');

  let cancelados = 0;
  for (const row of rows || []) {
    await db('ai_matters').where({ id: row.matter_id, user_id: userId }).update({
      status: 'pronto',
      scheduled_at: null,
      updated_at: db.fn.now(),
    });
    await db('ai_fila_jobs')
      .where({ matter_id: row.matter_id, status: 'pendente' })
      .update({
        status: 'cancelado',
        erro: 'Agenda pré-agendada — só agenda ao Confirmar',
      });
    cancelados += 1;
  }
  if (cancelados) {
    console.warn(`[agenda] user #${userId}: ${cancelados} matéria(s) pré-agendada(s) removidas de /minhas-materias`);
  }
  return { cancelados };
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

async function readequarHorariosPendentes(userId, { fromDate = null } = {}) {
  const itens = await BibliotecaAgenda.findByUser(userId, { status: 'pendente', limit: 200 });
  let lista = (itens || []).filter((row) => row.status === 'pendente');
  if (fromDate) {
    const day = toDatetimeLocal(fromDate).slice(0, 10);
    lista = lista.filter((row) => toDatetimeLocal(row.proposed_at).slice(0, 10) === day);
  }
  lista.sort((a, b) => new Date(a.proposed_at) - new Date(b.proposed_at));
  if (lista.length < 1) return { ajustados: 0 };

  const dayKey = toDatetimeLocal(lista[0].proposed_at).slice(0, 10);
  const { start, end } = dayBoundsAmanha();
  // Se a lista for do dia de amanhã, respeita confirmados/publicados
  let base = fromDate ? new Date(fromDate) : new Date(lista[0].proposed_at);

  const ocupadosFixos = await db(BibliotecaAgenda.table)
    .where({ user_id: userId })
    .whereIn('status', ['confirmado', 'publicado'])
    .where('proposed_at', '>=', start)
    .where('proposed_at', '<', end)
    .orderBy('proposed_at', 'desc')
    .first('proposed_at');

  if (ocupadosFixos?.proposed_at && toDatetimeLocal(ocupadosFixos.proposed_at).slice(0, 10) === dayKey) {
    const aposConfirmado = new Date(
      new Date(ocupadosFixos.proposed_at).getTime() + SLOT_MINUTES * 60 * 1000
    );
    if (aposConfirmado.getTime() > base.getTime()) base = aposConfirmado;
  }

  const first = new Date(lista[0].proposed_at);
  if (!ocupadosFixos?.proposed_at && first.getTime() < base.getTime()) base = first;

  let ajustados = 0;
  for (let i = 0; i < lista.length; i += 1) {
    const next = new Date(base.getTime() + i * SLOT_MINUTES * 60 * 1000);
    const cur = new Date(lista[i].proposed_at).getTime();
    if (cur !== next.getTime()) {
      await BibliotecaAgenda.update(lista[i].id, { proposed_at: next });
      ajustados += 1;
    }
  }
  return { ajustados };
}

async function excluirItem(userId, id, { apagarMateria = false } = {}) {
  const item = await getItemOwned(userId, id);
  const slotLiberado = item.proposed_at;
  await BibliotecaAgenda.deleteById(item.id, userId);
  if (apagarMateria && item.matter_id) {
    try {
      await AiMatters.deleteByUser(item.matter_id, userId);
    } catch {
      /* ignore */
    }
  }
  // Reagenda pendentes + confirmados do mesmo dia sem buracos de 30 min
  await compactarHorariosDoDia(userId, {
    dayKey: toDatetimeLocal(slotLiberado).slice(0, 10),
  });
  return { ok: true, itens: await listarAgenda(userId) };
}

/**
 * Remove da agenda itens que não batem nas palavras-chave do usuário
 * (pendente/confirmado). Usado ao montar com filtro e no botão de limpeza.
 */
async function limparItensSemPalavraChave(
  userId,
  { keywords = null, statuses = ['pendente', 'confirmado'], compactar = true } = {}
) {
  const BibliotecaAlertas = require('../models/BibliotecaAlertas');
  const Users = require('../models/Users');

  let kw = BibliotecaAlertas.parseKeywords(keywords);
  if (!kw.length) {
    const user = await Users.findById(userId);
    kw = BibliotecaAlertas.parseKeywords(user?.biblioteca_alertas_keywords);
  }
  if (!kw.length) {
    const err = new Error(
      'Nenhuma palavra-chave salva. Cadastre em Biblioteca → Palavras-chave.'
    );
    err.status = 400;
    throw err;
  }
  const keywordsStr = kw.join(', ');

  const itens = await BibliotecaAgenda.findByUser(userId, {
    statuses: Array.isArray(statuses) && statuses.length ? statuses : ['pendente', 'confirmado'],
    limit: 200,
    order: 'asc',
  });

  const remover = [];
  for (const row of itens || []) {
    // Variações de viralizadas não entram no filtro de palavras-chave da biblioteca
    if (row.source_matter_id) continue;
    const hits = BibliotecaAlertas.findMatchingKeywords(row, keywordsStr);
    if (hits.length) {
      // Garante chip gravado
      const label = hits.slice(0, 3).join(', ').slice(0, 60);
      if (String(row.matched_keyword || '').trim() !== label) {
        await BibliotecaAgenda.update(row.id, { matched_keyword: label }).catch(() => {});
      }
      continue;
    }
    remover.push(row);
  }

  for (const row of remover) {
    await BibliotecaAgenda.deleteById(row.id, userId);
  }

  if (compactar && remover.length) {
    await compactarHorariosAbertos(userId).catch((err) => {
      console.warn('[agenda] compactar após limpeza kw:', err.message);
    });
  }

  return {
    removidos: remover.length,
    keywordsUsadas: kw.length,
    ids: remover.map((r) => r.id),
  };
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
  // Após exclusões em lote, compacta o dia
  if (acao === 'excluir' && ok.length) {
    await compactarHorariosDoDia(userId);
  }
  return { ok: ok.length, erros, itens: await listarAgenda(userId) };
}

function diaHojeKey() {
  const amanha = startOfTomorrowAraguaina();
  const hoje = new Date(amanha.getTime() - 24 * 60 * 60 * 1000);
  return toDatetimeLocal(hoje).slice(0, 10);
}

/** Evita martelar o mesmo usuário a cada minuto do tick. */
const agendaAutoLastTick = new Map();
const AGENDA_AUTO_COOLDOWN_MS = 20 * 60 * 1000;
const AGENDA_AUTO_MAX_POR_CICLO = 5;
const AGENDA_AUTO_MAX_PENDENTES = 8;

/**
 * Continua a pré-agenda sozinho:
 * - Se já tem CONFIRMADO amanhã → preenche horários livres seguintes
 * - Se tem CONFIRMADO hoje e amanhã ainda está vazio → começa a montar amanhã (7h–22h)
 */
async function tickAgendaPre() {
  const dayAmanha = diaAmanhaKey();
  const dayHoje = diaHojeKey();
  const rows = await db(BibliotecaAgenda.table)
    .whereNotIn('status', ['cancelado'])
    .select('user_id', 'facebook_page_id', 'proposed_at', 'status');

  const amanhaPorUser = new Map();
  const hojeConfirmado = new Map(); // userId -> pageId

  for (const r of rows || []) {
    const uid = Number(r.user_id);
    const day = toDatetimeLocal(r.proposed_at).slice(0, 10);
    if (day === dayAmanha) {
      if (!amanhaPorUser.has(uid)) amanhaPorUser.set(uid, []);
      amanhaPorUser.get(uid).push(r);
    }
    if (day === dayHoje && r.status === 'confirmado') {
      const pageId = r.facebook_page_id != null ? Number(r.facebook_page_id) : null;
      if (pageId && !hojeConfirmado.has(uid)) hojeConfirmado.set(uid, pageId);
    }
  }

  const candidatos = new Set([
    ...[...amanhaPorUser.entries()]
      .filter(([, itens]) => itens.some((i) => i.status === 'confirmado'))
      .map(([uid]) => uid),
    ...[...hojeConfirmado.keys()].filter((uid) => !(amanhaPorUser.get(uid) || []).length),
  ]);

  let processados = 0;
  for (const userId of candidatos) {
    const itensAmanha = amanhaPorUser.get(userId) || [];
    const pendentes = itensAmanha.filter((i) => i.status === 'pendente').length;
    if (pendentes >= AGENDA_AUTO_MAX_PENDENTES) continue;

    const pageId =
      itensAmanha.map((i) => i.facebook_page_id).find((id) => id != null && Number(id) > 0) ||
      hojeConfirmado.get(userId);
    if (!pageId) continue;

    const last = agendaAutoLastTick.get(userId) || 0;
    if (Date.now() - last < AGENDA_AUTO_COOLDOWN_MS) continue;

    const maxItens = Math.min(AGENDA_AUTO_MAX_POR_CICLO, AGENDA_AUTO_MAX_PENDENTES - pendentes);
    if (maxItens < 1) continue;

    try {
      await compactarHorariosDoDia(userId, { dayKey: dayAmanha });

      // Se o usuário tem palavras-chave, o auto também respeita (igual ao checkbox).
      const BibliotecaAlertas = require('../models/BibliotecaAlertas');
      const Users = require('../models/Users');
      const user = await Users.findById(userId);
      const keywordsList = BibliotecaAlertas.parseKeywords(user?.biblioteca_alertas_keywords);
      const usarKeywords = keywordsList.length > 0;

      const result = await montarAgendaAmanha({
        userId,
        facebookPageId: Number(pageId),
        maxItens,
        somenteSites: true,
        usarKeywords,
      });
      agendaAutoLastTick.set(userId, Date.now());
      processados += 1;
      if (result.criados > 0 || result.removidosSemKw > 0) {
        console.log(
          `[agenda-auto] user #${userId}: +${result.criados || 0} pré-agendada(s)` +
            (result.removidosSemKw ? ` −${result.removidosSemKw} fora do filtro` : '') +
            (usarKeywords ? ' [keywords]' : '') +
            (result.de && result.ate ? ` (${result.de} → ${result.ate})` : '')
        );
      }
    } catch (err) {
      agendaAutoLastTick.set(userId, Date.now());
      if (err.status === 422) continue;
      console.warn(`[agenda-auto] user #${userId}:`, err.message);
    }
  }
  return { processados };
}

module.exports = {
  listarAgenda,
  listarViralizadas,
  agendarViralizada,
  contagensAgenda,
  montarAgendaAmanha,
  atualizarHorario,
  confirmarAgendamento,
  sincronizarAgendamentoDaMateria,
  cancelarAgendamentosPendentesDaBiblioteca,
  publicarAgora,
  excluirItem,
  readequarHorariosPendentes,
  repararHorariosSobrepostos,
  compactarHorariosDoDia,
  compactarHorariosAbertos,
  tickAgendaPre,
  acaoEmLote,
  limparItensSemPalavraChave,
  toDatetimeLocal,
  buildSlots,
  buildAllDaySlots,
  buildAllDaySlotsForDay,
  parseProposedAt,
  ultimoHorarioOcupadoAmanha,
  chaveHorario,
};
