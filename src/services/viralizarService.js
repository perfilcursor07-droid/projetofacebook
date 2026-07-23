/**
 * Conteúdo Viralizar — curadoria automática baseada no perfil de performance
 * da página (ex.: Apocalipse Gospel: polêmica, política×religião, escândalo).
 */
const materiaIaService = require('./materiaIaService');
const { buscarEmAltaAgora } = require('./trendingTopics');
const { pesquisarNichos } = require('./newsResearch');

/** Perfil editorial derivado do relatório FB (jun–jul/2026). */
const PERFIL_VIRAL = {
  id: 'apocalipse_gospel',
  nome: 'Apocalipse Gospel',
  melhoresHorarios: [12, 14, 16, 9, 8, 6],
  melhoresDias: ['terça', 'quarta'],
  evitarHorarios: [17, 18, 19, 20, 21, 22],
  preferirFormato: 'foto',
  /**
   * Seeds de busca (gospel BR + conflito). Mais termos = mais notícias relevantes.
   * pesquisarNichos aceita até 10 por chamada — usamos em lotes.
   */
  seedsBusca: [
    'pastor polêmica Brasil',
    'pastora igreja Brasil',
    'igreja evangélica política',
    'TSE igreja pastor',
    'Silas Malafaia',
    'escândalo pastor Brasil',
    'tumulto igreja evangélica',
    'vídeo vazado pastor',
    'Assembleia de Deus polêmica',
    'IURD pastor',
    'bispo Macedo',
    'cantor gospel polêmica',
    'pastor preso Brasil',
    'igreja Justiça Brasil',
    'líder evangélico denuncia',
    'culto polêmica Brasil',
    'pastor processado',
    'igreja evangélica Brasil notícia',
    'gospel Brasil polêmica',
    'Valdemiro Santiago',
    'Edir Macedo',
    'pastor viral Brasil',
  ],
};

const PALAVRAS_GOSPEL = [
  'pastor',
  'pastora',
  'igreja',
  'evangel',
  'gospel',
  'malafaia',
  'assembleia de deus',
  'iurd',
  'universal',
  'quadrilateral',
  'quadrangular',
  'culto',
  'bispo',
  'apostolo',
  'apóstolo',
  'crente',
  'louvor',
  'testemunho',
  'oracao',
  'oração',
  'biblia',
  'bíblia',
  'jesus',
  'cristo',
];

const PALAVRAS_POLITICA = [
  'tse',
  'eleitoral',
  'partido',
  'deputado',
  'senador',
  'vereador',
  'campanha',
  'eleicao',
  'eleição',
  'camara',
  'câmara',
  'congresso',
  'governo',
  'prefeito',
  'governador',
];

/** Fora do nicho da página — penaliza forte (mesmo se tiver "polêmica"). */
const FORA_NICHIO = [
  'chatgpt',
  'openai',
  'inteligencia artificial',
  'inteligência artificial',
  'sudario',
  'sudário',
  'vaticano',
  'papa francisco',
  'catolic',
  'padre exorcista',
  'africa',
  'áfrica',
  'italia',
  'itália',
  'extradi',
  'zambelli',
];

/**
 * Taxonomia viral (só aplica peso alto se o texto for do nicho gospel).
 */
const TAXONOMIA = [
  {
    id: 'tumulto_igreja',
    label: 'Tumulto / confusão em igreja',
    peso: 100,
    keywords: ['tumulto', 'confusao', 'confusão', 'bagunca', 'bagunça', 'briga', 'invasao', 'invasão'],
    exigeGospel: true,
  },
  {
    id: 'politica_religiao',
    label: 'Política + religião',
    peso: 92,
    keywords: PALAVRAS_POLITICA,
    exigeGospel: true,
    exigePoliticaEGospel: true,
  },
  {
    id: 'polemica',
    label: 'Polêmica',
    peso: 88,
    keywords: ['polemica', 'polêmica', 'repercussao', 'repercussão', 'declaracao', 'declaração', 'detona'],
    exigeGospel: true,
  },
  {
    id: 'escandalo',
    label: 'Escândalo / expôs',
    peso: 86,
    keywords: ['escandalo', 'escândalo', 'expos', 'expôs', 'vazou', 'vazado', 'denuncia', 'denúncia', 'acusad'],
    exigeGospel: true,
  },
  {
    id: 'pastora',
    label: 'Pastora / liderança feminina',
    peso: 82,
    keywords: ['pastora'],
    exigeGospel: false,
  },
  {
    id: 'justica',
    label: 'Justiça / processo',
    peso: 55,
    keywords: ['justica', 'justiça', 'processo', 'stf', 'prisao', 'prisão', 'condenad', 'investigad'],
    exigeGospel: true,
  },
  {
    id: 'crime',
    label: 'Crime',
    peso: 48,
    keywords: ['crime', 'fraude', 'desvio', 'roubo', 'assalto', 'preso'],
    exigeGospel: true,
  },
  {
    id: 'pastor',
    label: 'Pastor (figura pública)',
    peso: 50,
    keywords: ['pastor', 'bispo', 'apostolo', 'apóstolo'],
    exigeGospel: false,
  },
  {
    id: 'testemunho',
    label: 'Testemunho / fé',
    peso: 18,
    keywords: ['testemunho', 'conversao', 'conversão', 'aceitou jesus'],
    exigeGospel: true,
  },
  {
    id: 'cura_milagre',
    label: 'Cura / milagre',
    peso: 12,
    keywords: ['cura', 'milagre', 'ungido', 'libertacao', 'libertação'],
    exigeGospel: true,
  },
];

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function textoTopico(topico) {
  return [
    topico?.titulo,
    topico?.resumo,
    topico?.fonte,
    topico?.veiculo,
    ...(Array.isArray(topico?.veiculos) ? topico.veiculos : []),
  ]
    .filter(Boolean)
    .join(' ');
}

function temAlguma(texto, lista) {
  const t = stripAccents(texto);
  return lista.some((k) => t.includes(stripAccents(k)));
}

function hitsEm(texto, lista) {
  const t = stripAccents(texto);
  return lista.filter((k) => t.includes(stripAccents(k)));
}

function ehNichoGospel(texto) {
  return temAlguma(texto, PALAVRAS_GOSPEL);
}

function classificarTopico(topico) {
  const texto = textoTopico(topico);
  const tNorm = stripAccents(texto);
  const gospel = ehNichoGospel(texto);
  const politica = temAlguma(texto, PALAVRAS_POLITICA);
  const fora = temAlguma(texto, FORA_NICHIO);

  let melhor = { id: 'geral', label: 'Geral / outros', peso: 20, matches: [] };
  let scoreTax = 20;

  for (const cat of TAXONOMIA) {
    if (cat.exigeGospel && !gospel) continue;
    if (cat.exigePoliticaEGospel && !(gospel && politica)) continue;

    const hits = hitsEm(texto, cat.keywords);
    if (!hits.length) continue;

    // "política" sozinha sem igreja não entra (já barrada por exigePoliticaEGospel)
    const bonus = hits.length * 5;
    const score = cat.peso + bonus;
    if (score > scoreTax) {
      scoreTax = score;
      melhor = { id: cat.id, label: cat.label, peso: cat.peso, matches: hits };
    }
  }

  let score = scoreTax;

  if (gospel) score += 35;
  else score -= 45;

  if (gospel && politica) score += 25;
  if (/\bpastora\b/i.test(tNorm)) score += 18;
  if (/\b(malafaia|macedo|valdemiro|eadir)\b/i.test(tNorm)) score += 15;
  if (/\b(brasil|fortaleza|sao paulo|rio de janeiro|bahia|cuiaba|belo horizonte|recife)\b/i.test(tNorm)) {
    score += 10;
  }

  if (fora) {
    // Tech/católico/internacional genérico: derruba, salvo se for bem gospel
    score -= gospel ? 25 : 70;
  }

  if (topico?.calor) score += Math.min(15, Number(topico.calor) || 0);
  if (topico?.contagemFontes) score += Math.min(8, Number(topico.contagemFontes) * 2);
  if (topico?.jaPublicado) score -= 80;

  const baixoAlcance = ['testemunho', 'cura_milagre', 'geral'].includes(melhor.id);
  if (!gospel) {
    melhor = { id: 'fora_nicho', label: 'Fora do nicho', peso: 0, matches: [] };
  }

  let potencial = 'medio';
  if (gospel && score >= 90) potencial = 'alto';
  else if (!gospel || score < 50 || baixoAlcance) potencial = 'baixo';

  return {
    temaPrincipal: melhor.id,
    temaLabel: melhor.label,
    scoreViral: Math.round(Math.max(0, score)),
    potencial,
    nichoGospel: gospel,
    gatilho:
      melhor.id === 'politica_religiao' || melhor.id === 'polemica' || melhor.id === 'escandalo'
        ? 'indignacao'
        : melhor.id === 'pastora'
          ? 'curiosidade'
          : 'surpresa',
    envolveFiguraPublica: /\b(pastor|pastora|bispo|malafaia|deputad|senador|cantor)\b/i.test(tNorm),
    generoFigura: /\bpastora\b/i.test(tNorm) ? 'feminino' : /\bpastor\b/i.test(tNorm) ? 'masculino' : 'nao_aplicavel',
    nivelPolemica: Math.min(5, Math.max(0, Math.round((score - 40) / 20))),
    matches: melhor.matches || [],
  };
}

function proximoSlotSugerido() {
  const agora = new Date();
  const dia = agora.getDay();
  const hora = agora.getHours();
  const melhoresDiasNum = [2, 3];
  const horarios = PERFIL_VIRAL.melhoresHorarios;

  if (melhoresDiasNum.includes(dia)) {
    const proxHora = horarios.find((h) => h > hora);
    if (proxHora != null) {
      return {
        dia: dia === 2 ? 'terça' : 'quarta',
        hora: proxHora,
        label: `Hoje às ${proxHora}h (melhor faixa da página)`,
      };
    }
  }

  let add = 1;
  while (add < 8) {
    const d = new Date(agora);
    d.setDate(agora.getDate() + add);
    if (melhoresDiasNum.includes(d.getDay())) {
      const nome = d.getDay() === 2 ? 'terça' : 'quarta';
      return {
        dia: nome,
        hora: 12,
        label: `${nome} às 12h (melhor combinação histórica)`,
      };
    }
    add += 1;
  }
  return { dia: 'terça', hora: 12, label: 'Terça às 12h' };
}

function dedupeTitulos(lista) {
  const out = [];
  for (const item of lista) {
    const t = String(item.titulo || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) continue;
    const dup = out.some((x) => {
      const a = String(x.titulo || '')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      if (a === t) return true;
      if (a.length > 24 && t.length > 24 && (a.includes(t.slice(0, 28)) || t.includes(a.slice(0, 28)))) {
        return true;
      }
      return false;
    });
    if (!dup) out.push(item);
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Busca pautas automaticamente e ranqueia pelo perfil viral (só nicho gospel).
 * Conteúdo recente + busca profunda em vários termos/sites.
 * Pautas já publicadas/agendadas saem da lista principal e vão em `excluidos`.
 */
async function curarPautasVirais({ userId, facebookPageId, limit = 20 } = {}) {
  const lim = Math.min(28, Math.max(5, Number(limit) || 20));
  const avisos = [];
  let brutos = [];

  // 1) Em alta (48h) — a API devolve { topicos }
  try {
    const emAlta = await buscarEmAltaAgora(PERFIL_VIRAL.seedsBusca.slice(0, 10).join(', '), {
      horas: 48,
    });
    const lista = Array.isArray(emAlta) ? emAlta : emAlta?.topicos || [];
    brutos = brutos.concat(lista);
  } catch (err) {
    avisos.push(`Em alta: ${err.message}`);
  }

  // 2) Nichos em lotes — mais termos × mais itens (notícias recentes de vários sites)
  const lotesSeeds = chunk(PERFIL_VIRAL.seedsBusca, 8);
  for (const lote of lotesSeeds) {
    try {
      const nichos = await pesquisarNichos(lote.join(', '), 8, {
        incluirRedesSociais: false,
        filtrarPeriodo: true,
        diasRecentes: 3,
      });
      brutos = brutos.concat(nichos || []);
    } catch (err) {
      avisos.push(`Nichos: ${err.message}`);
    }
  }

  brutos = dedupeTitulos(brutos);
  if (!brutos.length) {
    const err = new Error('Nenhuma pauta encontrada agora. Tente novamente em alguns minutos.');
    err.status = 404;
    err.avisos = avisos;
    throw err;
  }

  let topicos = await materiaIaService.marcarJaPublicados(userId, facebookPageId, brutos);

  const jaUsados = topicos.filter((t) => t.jaPublicado);
  const novos = topicos.filter((t) => !t.jaPublicado);

  const classificados = novos
    .map((t) => {
      const meta = classificarTopico(t);
      return {
        ...t,
        ...meta,
        calorViral: meta.scoreViral + (Number(t.calor) || 0),
      };
    })
    .sort((a, b) => b.scoreViral - a.scoreViral || b.calorViral - a.calorViral);

  const noNicho = classificados.filter((t) => t.nichoGospel);
  const fora = classificados.filter((t) => !t.nichoGospel);
  const base = noNicho.length >= 5 ? noNicho : [...noNicho, ...fora];

  const altos = base.filter((t) => t.potencial === 'alto');
  const medios = base.filter((t) => t.potencial === 'medio');
  const baixos = base.filter((t) => t.potencial === 'baixo');
  const ranqueados = [...altos, ...medios, ...baixos].slice(0, lim);

  ranqueados.forEach((t, i) => {
    t.posicao = i + 1;
  });

  const excluidos = jaUsados.slice(0, 15).map((t) => ({
    titulo: t.titulo,
    link: t.link || null,
    fonte: t.veiculo || t.fonte || null,
    motivo: 'Já publicada ou agendada nesta página',
  }));

  if (excluidos.length) {
    avisos.push(`${excluidos.length} pauta(s) já usada(s) foram ocultadas da lista.`);
  }
  if (noNicho.length < 5) {
    avisos.push(
      `Poucas notícias gospel no radar agora (${noNicho.length}). Ampliei a busca; rode de novo em alguns minutos.`
    );
  }

  return {
    topicos: ranqueados,
    excluidos,
    totalAnalisado: brutos.length,
    totalGospel: noNicho.length,
    totalExcluidos: excluidos.length,
    perfil: {
      id: PERFIL_VIRAL.id,
      nome: PERFIL_VIRAL.nome,
      preferirFormato: PERFIL_VIRAL.preferirFormato,
      melhoresHorarios: PERFIL_VIRAL.melhoresHorarios,
      melhoresDias: PERFIL_VIRAL.melhoresDias,
    },
    slotSugerido: proximoSlotSugerido(),
    avisos,
    geradoEm: new Date().toISOString(),
  };
}

async function gerarDePautas({
  userId,
  facebookPageId,
  topicos,
  tipoPublicacao = 'foto',
  publicar = false,
} = {}) {
  const lista = Array.isArray(topicos) ? topicos.filter((t) => t && t.titulo) : [];
  if (!lista.length) {
    const err = new Error('Selecione ao menos uma pauta');
    err.status = 400;
    throw err;
  }

  const tipo = tipoPublicacao === 'texto' ? 'texto' : 'foto';
  const status = publicar ? 'publicado' : 'rascunho';
  const gerados = [];
  const erros = [];

  for (const topico of lista.slice(0, 5)) {
    try {
      const result = await materiaIaService.gerarCompleto({
        userId,
        topico: {
          ...topico,
          anguloViral: topico.temaLabel || topico.temaPrincipal,
          potencialViral: topico.potencial,
        },
        facebookPageId,
        tipoPublicacao: tipo,
        status,
        furoReportagem: true,
        variacaoViral: true,
      });
      gerados.push({
        matterId: result.matter?.id,
        titulo: result.matter?.titulo || result.artigo?.titulo,
        status: result.matter?.status,
        publicado: Boolean(result.publication),
        tema: topico.temaLabel || null,
        potencial: topico.potencial || null,
        redirect: result.matter?.id ? `/materias-ia/${result.matter.id}` : null,
      });
    } catch (err) {
      erros.push({ titulo: topico.titulo, error: err.message });
    }
  }

  return {
    ok: true,
    gerados,
    erros,
    total: gerados.length,
    publicar,
    mensagem: publicar
      ? `${gerados.length} matéria(s) gerada(s) e enviada(s) para publicação.`
      : `${gerados.length} rascunho(s) em Matérias salvas — revise e publique quando quiser.`,
  };
}

module.exports = {
  PERFIL_VIRAL,
  TAXONOMIA,
  classificarTopico,
  curarPautasVirais,
  gerarDePautas,
  proximoSlotSugerido,
};
