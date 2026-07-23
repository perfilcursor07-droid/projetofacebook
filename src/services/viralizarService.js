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
  /** Seeds de busca automática (sem o usuário digitar). */
  seedsBusca: [
    'pastor polêmica',
    'pastora igreja',
    'igreja política',
    'TSE igreja',
    'Malafaia',
    'escândalo pastor',
    'tumulto igreja',
    'vídeo pastor',
  ],
};

/**
 * Taxonomia + pesos (quanto maior, mais alinhado ao que viraliza na página).
 * Conteúdo devocional fica baixo de propósito (manutenção, não crescimento).
 */
const TAXONOMIA = [
  {
    id: 'tumulto_igreja',
    label: 'Tumulto / confusão em igreja',
    peso: 100,
    keywords: ['tumulto', 'confusão', 'bagunça', 'briga', 'invasão', 'protesto igreja'],
  },
  {
    id: 'politica_religiao',
    label: 'Política + religião',
    peso: 92,
    keywords: [
      'tse',
      'eleitoral',
      'partido',
      'política',
      'politica',
      'deputado',
      'senador',
      'vereador',
      'campanha',
      'urna',
      'eleição',
      'eleicao',
    ],
  },
  {
    id: 'polemica',
    label: 'Polêmica',
    peso: 88,
    keywords: ['polêmica', 'polemica', 'repercussão', 'repercussao', 'declaração', 'declaracao', 'detona', 'explode'],
  },
  {
    id: 'escandalo',
    label: 'Escândalo / expôs',
    peso: 86,
    keywords: ['escândalo', 'escandalo', 'expôs', 'expos', 'vazou', 'vazado', 'denúncia', 'denuncia', 'acusad'],
  },
  {
    id: 'pastora',
    label: 'Pastora / liderança feminina',
    peso: 82,
    keywords: ['pastora', 'bispo mulher', 'liderança feminina', 'lideranca feminina'],
  },
  {
    id: 'justica',
    label: 'Justiça / processo',
    peso: 55,
    keywords: ['justiça', 'justica', 'processo', 'stf', 'prisão', 'prisao', 'condenad', 'investigad'],
  },
  {
    id: 'crime',
    label: 'Crime',
    peso: 48,
    keywords: ['crime', 'fraude', 'desvio', 'roubo', 'assalto'],
  },
  {
    id: 'pastor',
    label: 'Pastor (figura pública)',
    peso: 45,
    keywords: ['pastor', 'bispo', 'apóstolo', 'apostolo', 'líder religioso', 'lider religioso'],
  },
  {
    id: 'testemunho',
    label: 'Testemunho / fé',
    peso: 18,
    keywords: ['testemunho', 'conversão', 'conversao', 'aceitou jesus', 'fé', 'fe '],
  },
  {
    id: 'cura_milagre',
    label: 'Cura / milagre',
    peso: 12,
    keywords: ['cura', 'milagre', 'ungido', 'libertação', 'libertacao'],
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

function classificarTopico(topico) {
  const texto = stripAccents(textoTopico(topico));
  let melhor = { id: 'geral', label: 'Geral / outros', peso: 25, matches: [] };
  let scoreTax = 25;

  for (const cat of TAXONOMIA) {
    const hits = cat.keywords.filter((k) => texto.includes(stripAccents(k)));
    if (!hits.length) continue;
    const bonus = hits.length * 4;
    const score = cat.peso + bonus;
    if (score > scoreTax) {
      scoreTax = score;
      melhor = { id: cat.id, label: cat.label, peso: cat.peso, matches: hits };
    }
  }

  const temFigura =
    /\b(pastor|pastora|bispo|malafaia|deputad|senador|cantor|ministro)\b/i.test(texto);
  const temNomeProprio = /\b[\p{Lu}][\p{L}'’-]{2,}(?:\s+(?:da|das|de|do|dos)?\s*[\p{Lu}][\p{L}'’-]{2,})+/u.test(
    String(topico?.titulo || '')
  );
  const feminino = /\bpastora\b/i.test(texto);

  let score = scoreTax;
  if (temFigura) score += 12;
  if (temNomeProprio) score += 10;
  if (feminino) score += 15;
  if (topico?.calor) score += Math.min(20, Number(topico.calor) || 0);
  if (topico?.contagemFontes) score += Math.min(10, Number(topico.contagemFontes) * 2);
  if (topico?.jaPublicado) score -= 80;

  // Devocional puro: não matar da lista, mas marcar potencial baixo
  const baixoAlcance = ['testemunho', 'cura_milagre'].includes(melhor.id);

  let potencial = 'medio';
  if (score >= 95) potencial = 'alto';
  else if (score < 45 || baixoAlcance) potencial = 'baixo';

  return {
    temaPrincipal: melhor.id,
    temaLabel: melhor.label,
    scoreViral: Math.round(score),
    potencial,
    gatilho: melhor.id.includes('politica') || melhor.id === 'polemica' || melhor.id === 'escandalo'
      ? 'indignacao'
      : melhor.id === 'pastora'
        ? 'curiosidade'
        : 'surpresa',
    envolveFiguraPublica: temFigura || temNomeProprio,
    generoFigura: feminino ? 'feminino' : temFigura ? 'masculino' : 'nao_aplicavel',
    nivelPolemica: Math.min(5, Math.max(0, Math.round((score - 30) / 20))),
    matches: melhor.matches || [],
  };
}

function proximoSlotSugerido() {
  const agora = new Date();
  const dia = agora.getDay(); // 0=dom
  const hora = agora.getHours();
  const melhoresDiasNum = [2, 3]; // terça, quarta
  const horarios = PERFIL_VIRAL.melhoresHorarios;

  // Se hoje é bom e ainda dá tempo, sugere próximo horário bom
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

  // Próxima terça/quarta às 12h
  let add = 1;
  let d = new Date(agora);
  while (add < 8) {
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

/**
 * Busca pautas automaticamente (sem o usuário digitar) e ranqueia pelo perfil viral.
 */
async function curarPautasVirais({ userId, facebookPageId, limit = 12 } = {}) {
  const lim = Math.min(20, Math.max(3, Number(limit) || 12));
  const avisos = [];

  const seeds = PERFIL_VIRAL.seedsBusca.join(', ');
  let brutos = [];

  try {
    const emAlta = await buscarEmAltaAgora(seeds, { horas: 24 });
    brutos = brutos.concat(emAlta || []);
  } catch (err) {
    avisos.push(`Em alta: ${err.message}`);
  }

  try {
    const nichos = await pesquisarNichos(seeds, 4, {
      incluirRedesSociais: false,
      filtrarPeriodo: true,
      diasRecentes: 2,
    });
    brutos = brutos.concat(nichos || []);
  } catch (err) {
    avisos.push(`Nichos: ${err.message}`);
  }

  brutos = dedupeTitulos(brutos);
  if (!brutos.length) {
    const err = new Error('Nenhuma pauta encontrada agora. Tente novamente em alguns minutos.');
    err.status = 404;
    err.avisos = avisos;
    throw err;
  }

  let topicos = await materiaIaService.marcarJaPublicados(userId, facebookPageId, brutos);

  topicos = topicos
    .map((t) => {
      const meta = classificarTopico(t);
      return {
        ...t,
        ...meta,
        calorViral: meta.scoreViral + (Number(t.calor) || 0),
      };
    })
    .filter((t) => !t.jaPublicado)
    .sort((a, b) => b.scoreViral - a.scoreViral || b.calorViral - a.calorViral)
    .slice(0, lim);

  // Preferir alto/médio potencial no topo; manter alguns médios se lista curta
  const altos = topicos.filter((t) => t.potencial === 'alto');
  const medios = topicos.filter((t) => t.potencial === 'medio');
  const baixos = topicos.filter((t) => t.potencial === 'baixo');
  const ranqueados = [...altos, ...medios, ...baixos].slice(0, lim);

  ranqueados.forEach((t, i) => {
    t.posicao = i + 1;
  });

  return {
    topicos: ranqueados,
    totalAnalisado: brutos.length,
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

/**
 * Gera matérias a partir de tópicos curados.
 * @param {{ status?: 'rascunho'|'publicado', publicar?: boolean }}
 */
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
          // Ângulo viral no contexto da geração
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
