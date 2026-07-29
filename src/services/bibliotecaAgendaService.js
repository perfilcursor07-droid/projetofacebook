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

/** Chave estável do horário na TZ Araguaina: YYYY-MM-DDTHH:mm */
function chaveHorario(date) {
  return toDatetimeLocal(date).slice(0, 16);
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
  // Confirmado/agendado: horário de publicação da matéria é a fonte da verdade (igual /minhas-materias)
  const st = String(row.status || '');
  const matterSt = String(row.matter_status || '');
  const scheduled =
    (st === 'confirmado' || matterSt === 'agendado') && row.matter_scheduled_at
      ? row.matter_scheduled_at
      : row.proposed_at;
  return {
    ...row,
    proposed_at: scheduled || row.proposed_at,
    proposed_at_local: toDatetimeLocal(scheduled || row.proposed_at),
    titulo: row.matter_titulo || row.post_titulo || 'Sem título',
    thumb,
    ui_status:
      st === 'confirmado' || matterSt === 'agendado'
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

/** Alinha status/horário da agenda com a matéria (evita Confirmado ≠ Agendada). */
async function sincronizarComMaterias(userId, itens) {
  const lista = Array.isArray(itens) ? itens : [];
  for (const row of lista) {
    if (!row.matter_id) continue;
    const agendaSt = String(row.status || '');
    const matterSt = String(row.matter_status || '');
    try {
      if (matterSt === 'agendado' && agendaSt === 'pendente') {
        await BibliotecaAgenda.update(row.id, { status: 'confirmado' });
        row.status = 'confirmado';
      }
      if (matterSt === 'publicado' && agendaSt !== 'publicado') {
        await BibliotecaAgenda.update(row.id, { status: 'publicado' });
        row.status = 'publicado';
      }
      if (
        (agendaSt === 'confirmado' || matterSt === 'agendado') &&
        row.matter_scheduled_at
      ) {
        const a = new Date(row.proposed_at).getTime();
        const b = new Date(row.matter_scheduled_at).getTime();
        if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 60_000) {
          await BibliotecaAgenda.update(row.id, { proposed_at: new Date(row.matter_scheduled_at) });
          row.proposed_at = row.matter_scheduled_at;
        }
      }
    } catch {
      /* não bloqueia listagem */
    }
  }
  return lista;
}

/** Itens ativos do dia (filtra por chave local — evita erro de fuso no WHERE). */
async function itensAgendaDoDia(userId, dayKey = null) {
  const day = dayKey || diaAmanhaKey();
  const rows = await db(BibliotecaAgenda.table)
    .where({ user_id: userId })
    .whereNotIn('status', ['cancelado'])
    .select('id', 'proposed_at', 'status', 'post_id', 'matter_id');
  return (rows || []).filter((r) => toDatetimeLocal(r.proposed_at).slice(0, 10) === day);
}

/** Último horário já ocupado amanhã (pendente, confirmado ou publicado). */
async function ultimoHorarioOcupadoAmanha(userId) {
  const itens = await itensAgendaDoDia(userId);
  if (!itens.length) return null;
  let max = null;
  for (const r of itens) {
    const t = new Date(r.proposed_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (max == null || t > max) max = t;
  }
  return max != null ? new Date(max) : null;
}

/**
 * Compacta pendentes + confirmados do dia em horários contínuos de 30 em 30 min
 * (preenche buracos tipo 09:00 → 10:30). Publicados ficam fixos.
 */
async function compactarHorariosDoDia(userId, { dayKey = null } = {}) {
  const day = dayKey || diaAmanhaKey();
  const todos = await itensAgendaDoDia(userId, day);
  const publicadosKeys = new Set(
    todos.filter((r) => r.status === 'publicado').map((r) => chaveHorario(r.proposed_at))
  );
  const itens = todos
    .filter((r) => r.status === 'pendente' || r.status === 'confirmado')
    .sort((a, b) => new Date(a.proposed_at) - new Date(b.proposed_at));
  if (itens.length < 1) return { ajustados: 0 };

  const slotsLivres = buildAllDaySlots().filter((s) => !publicadosKeys.has(chaveHorario(s)));
  if (!slotsLivres.length) return { ajustados: 0 };

  const firstKey = chaveHorario(itens[0].proposed_at);
  let startIdx = slotsLivres.findIndex((s) => chaveHorario(s) === firstKey);
  if (startIdx < 0) {
    const firstMs = new Date(itens[0].proposed_at).getTime();
    startIdx = slotsLivres.findIndex((s) => s.getTime() >= firstMs);
    if (startIdx < 0) startIdx = 0;
  }

  let precisa = itens.length > slotsLivres.length - startIdx;
  if (!precisa) {
    for (let i = 0; i < itens.length; i += 1) {
      const expected = slotsLivres[startIdx + i];
      if (!expected || chaveHorario(itens[i].proposed_at) !== chaveHorario(expected)) {
        precisa = true;
        break;
      }
    }
  }
  // Também detecta choque (dois no mesmo horário)
  if (!precisa) {
    const seen = new Set();
    for (const r of itens) {
      const k = chaveHorario(r.proposed_at);
      if (seen.has(k)) {
        precisa = true;
        break;
      }
      seen.add(k);
    }
  }
  if (!precisa) return { ajustados: 0 };

  let ajustados = 0;
  for (let i = 0; i < itens.length; i += 1) {
    const slot = slotsLivres[startIdx + i];
    if (!slot) break;
    if (chaveHorario(itens[i].proposed_at) === chaveHorario(slot)) continue;

    await BibliotecaAgenda.update(itens[i].id, { proposed_at: slot });
    if (itens[i].status === 'confirmado' && itens[i].matter_id) {
      try {
        await materiaIaService.agendarMateria({
          userId,
          matterId: itens[i].matter_id,
          runAt: slot.toISOString(),
        });
      } catch {
        /* agenda compactada mesmo se a fila falhar */
      }
    }
    ajustados += 1;
  }
  return { ajustados };
}

/** @deprecated use compactarHorariosDoDia — mantido como alias */
async function repararHorariosSobrepostos(userId) {
  return compactarHorariosDoDia(userId);
}

async function listarAgenda(userId, { status = 'all', aba = null, reparar = true } = {}) {
  if (reparar) {
    try {
      await compactarHorariosDoDia(userId);
    } catch {
      /* não bloqueia listagem */
    }
  }

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

  const itens = await BibliotecaAgenda.findByUser(userId, {
    status: filterStatus,
    statuses,
    limit: 120,
    order,
  });
  await sincronizarComMaterias(userId, itens || []);
  return (itens || []).map(mapItem);
}

async function contagensAgenda(userId) {
  return BibliotecaAgenda.countByStatus(userId);
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

  const maxPedidos = Math.min(48, Math.max(1, Number(maxItens) || DEFAULT_MAX_ITENS));
  // NÃO compacta/remarca o que já está pré-agendado ou confirmado —
  // só encaixa novos itens nos horários livres depois do último ocupado.
  const itensDia = await itensAgendaDoDia(userId);
  const ocupadosKeys = new Set(itensDia.map((r) => chaveHorario(r.proposed_at)));
  const ultimoOcupado = await ultimoHorarioOcupadoAmanha(userId);
  const slots = buildSlots({
    startHour: Number(startHour) || DEFAULT_START_HOUR,
    endHour: Number(endHour) || DEFAULT_END_HOUR,
    max: maxPedidos,
    afterDate: ultimoOcupado,
    ocupadosKeys,
  });

  if (!slots.length) {
    const ate = ultimoOcupado ? toDatetimeLocal(ultimoOcupado).replace('T', ' ') : null;
    const err = new Error(
      ate
        ? `Não há horários livres amanhã após ${ate} (janela ${startHour}h–${endHour}h). Exclua itens ou use outro dia.`
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
        });
        criados.push({ id, postId: post.id, matterId, proposedAt });
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
    await materiaIaService.agendarMateria({
      userId,
      matterId: item.matter_id,
      runAt: parsed.toISOString(),
    });
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
      const result = await montarAgendaAmanha({
        userId,
        facebookPageId: Number(pageId),
        maxItens,
        somenteSites: true,
      });
      agendaAutoLastTick.set(userId, Date.now());
      processados += 1;
      if (result.criados > 0) {
        console.log(
          `[agenda-auto] user #${userId}: +${result.criados} pré-agendada(s)` +
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
  contagensAgenda,
  montarAgendaAmanha,
  atualizarHorario,
  confirmarAgendamento,
  publicarAgora,
  excluirItem,
  readequarHorariosPendentes,
  repararHorariosSobrepostos,
  compactarHorariosDoDia,
  tickAgendaPre,
  acaoEmLote,
  toDatetimeLocal,
  buildSlots,
  buildAllDaySlots,
  parseProposedAt,
  ultimoHorarioOcupadoAmanha,
  chaveHorario,
};
