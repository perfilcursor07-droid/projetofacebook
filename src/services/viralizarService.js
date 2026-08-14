/**
 * Conteúdo Viralizar — curadoria automática baseada no perfil de performance
 * da página (ex.: Apocalipse Gospel: polêmica, política×religião, escândalo).
 */
const materiaIaService = require('./materiaIaService');
const { buscarEmAltaAgora } = require('./trendingTopics');
const { pesquisarNichos, extrairDataDeTexto } = require('./newsResearch');

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
  /**
   * Queries usadas na busca de Reels Instagram (ScrapeCreators) — máx. 4 por curadoria.
   */
  seedsInstagram: [
    'pastor polêmica Brasil',
    'Silas Malafaia',
    'pastora igreja',
    'escândalo pastor',
  ],
  /**
   * Perfis gospel no Instagram — coleta direta por perfil (mais estável que a
   * busca por palavra-chave, que às vezes cai em desafio temporário).
   */
  perfisRadarIg: [
    { nome: 'Folha Gospel', handle: 'folhagospel' },
    { nome: 'Gospel Mais', handle: 'gospelmais' },
    { nome: 'Guiame', handle: 'guiame' },
    { nome: 'Notícias Gospel', handle: 'noticiasgospel' },
    { nome: 'Silas Malafaia', handle: 'silasmalafaia' },
  ],
  /**
   * Páginas FB concorrentes / portais gospel — 1 request (~3 posts) cada, máx. 5.
   */
  paginasRadarFb: [
    { nome: 'Folha Gospel', url: 'https://www.facebook.com/FolhaGospel' },
    { nome: 'Comunhão', url: 'https://www.facebook.com/comunhao' },
    { nome: 'Gospel Mais', url: 'https://www.facebook.com/gospelmais' },
    { nome: 'Guiame', url: 'https://www.facebook.com/guiame' },
    { nome: 'Silas Malafaia', url: 'https://www.facebook.com/SilasMalafaia' },
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

  // Engajamento real (ScrapeCreators FB/IG)
  const likes = Number(topico?.likes) || 0;
  const comments = Number(topico?.comments) || 0;
  const shares = Number(topico?.shares) || 0;
  const views = Number(topico?.views) || 0;
  if (likes || comments || shares || views) {
    const engBonus = Math.min(
      25,
      Math.log(likes + 1) * 4 + Math.log(comments + 1) * 3 + Math.log(shares + 1) * 2 + Math.log(views + 1) * 1.2
    );
    score += engBonus;
  }
  if (topico?.redeSocial || topico?.origemSocial) {
    score += 5;
  }

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
    const linkKey = String(item.link || '')
      .split(/[?#]/)[0]
      .toLowerCase()
      .replace(/\/$/, '');
    if (linkKey && out.some((x) => String(x.link || '').split(/[?#]/)[0].toLowerCase().replace(/\/$/, '') === linkKey)) {
      continue;
    }

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

const STOPWORDS_SEMENTES_PUBLICO = new Set([
  'a', 'as', 'ao', 'aos', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos',
  'o', 'os', 'para', 'por', 'que', 'se', 'sem', 'sobre', 'um', 'uma', 'com', 'como', 'mais',
  'apos', 'durante', 'brasil', 'entenda', 'veja', 'saiba', 'revela', 'afirma', 'diz', 'gera',
  'gospel', 'evangelico', 'evangelica', 'evangelicos', 'evangelicas', 'igreja', 'igrejas',
  'cristao', 'crista', 'cristaos', 'materia', 'noticia', 'publicacao', 'quarta', 'sexta',
]);

function scoreEngajamentoMateria(matter) {
  return (
    (Number(matter?.pub_fb_likes) || 0) +
    (Number(matter?.pub_fb_comments) || 0) * 3 +
    (Number(matter?.pub_fb_shares) || 0) * 5 +
    Math.min(Number(matter?.pub_fb_views) || 0, 5000) / 50
  );
}

function sementesFallbackDoPublico(materias, limit = 6) {
  const vistas = new Set();
  const consultas = [];
  for (const materia of (materias || []).slice(0, 20)) {
    const palavras = stripAccents(materia?.titulo)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((p) => p.length >= 4 && !STOPWORDS_SEMENTES_PUBLICO.has(p))
      .slice(0, 5);
    if (palavras.length < 2) continue;
    const consulta = `${palavras.join(' ')} notícia recente`;
    const key = stripAccents(consulta);
    if (vistas.has(key)) continue;
    vistas.add(key);
    consultas.push(consulta);
    if (consultas.length >= limit) break;
  }
  return consultas;
}

function identidadePublicacao(matter) {
  return (
    String(matter?.publication_id || '').trim() ||
    String(matter?.pub_fb_native_post_id || '').trim() ||
    String(matter?.pub_fb_post_url || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase() ||
    String(matter?.pub_fb_post_id || '').trim() ||
    `matter:${matter?.id}`
  );
}

/** Remove matérias repetidas e métricas obviamente copiadas entre posts distintos. */
function filtrarBasesComMetricasConfiaveis(materias) {
  const porPublicacao = new Map();
  for (const matter of materias || []) {
    const key = identidadePublicacao(matter);
    const atual = porPublicacao.get(key);
    if (!atual || scoreEngajamentoMateria(matter) > scoreEngajamentoMateria(atual)) {
      porPublicacao.set(key, matter);
    }
  }

  const unicas = [...porPublicacao.values()];
  const porAssinatura = new Map();
  for (const matter of unicas) {
    const likes = Number(matter?.pub_fb_likes) || 0;
    const comments = Number(matter?.pub_fb_comments) || 0;
    const shares = Number(matter?.pub_fb_shares) || 0;
    const views = Number(matter?.pub_fb_views) || 0;
    if (!(likes || comments || shares || views)) continue;
    const signature = `${likes}|${comments}|${shares}|${views}`;
    if (!porAssinatura.has(signature)) porAssinatura.set(signature, []);
    porAssinatura.get(signature).push(matter);
  }

  const suspeitas = new Set();
  for (const grupo of porAssinatura.values()) {
    if (grupo.length < 2) continue;
    const sample = grupo[0];
    const alto =
      Number(sample?.pub_fb_likes) >= 100 ||
      Number(sample?.pub_fb_comments) >= 50 ||
      Number(sample?.pub_fb_shares) >= 25 ||
      Number(sample?.pub_fb_views) >= 1000;
    if (!alto) continue;
    for (const matter of grupo) suspeitas.add(Number(matter.id));
  }

  return {
    materias: unicas.filter((matter) => !suspeitas.has(Number(matter.id))),
    duplicadas: Math.max(0, (materias || []).length - unicas.length),
    suspeitas: suspeitas.size,
  };
}

const EIXOS_INTERESSE_PUBLICO = {
  escatologia: ['anticristo', 'arrebatamento', 'apocalipse', 'profecia', 'messias', 'fim dos tempos'],
  musica_gospel: ['cantor', 'cantora', 'louvor', 'musica', 'spotify', 'album', 'single', 'show', 'adoração'],
  influenciadores: ['influenciador', 'influenciadora', 'instagram', 'tiktok', 'redes sociais', 'milhoes de views', 'viralizou'],
  politica_religiao: ['politica', 'eleicao', 'presidente', 'deputado', 'senador', 'governo', 'comunismo', 'direita', 'esquerda'],
  polemica: ['polemica', 'critica', 'revolta', 'desabafo', 'detona', 'acusa', 'denuncia', 'escandalo', 'repercussao'],
  lideranca: ['pastor', 'pastora', 'bispo', 'apostolo', 'lider evangelico'],
  testemunho: ['testemunho', 'livramento', 'milagre', 'cura', 'conversao', 'aceitou jesus'],
  perseguicao: ['perseguicao', 'perseguido', 'prisao', 'preso', 'condenado', 'cristaos perseguidos'],
  familia_costumes: ['familia', 'casamento', 'aborto', 'lgbt', 'sexualidade', 'filhos'],
  biblia_doutrina: ['biblia', 'biblico', 'doutrina', 'versiculo', 'teologia', 'pecado'],
  evento: ['congresso', 'conferencia', 'evento', 'festival', 'premiacao', 'missões'],
};

function eixosDoTexto(texto) {
  const normalizado = stripAccents(texto);
  return Object.entries(EIXOS_INTERESSE_PUBLICO)
    .filter(([, termos]) => termos.some((termo) => normalizado.includes(stripAccents(termo))))
    .map(([id]) => id);
}

function tokensDeAfinidade(texto) {
  return new Set(
    stripAccents(texto)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 5 && !STOPWORDS_SEMENTES_PUBLICO.has(token))
  );
}

function avaliarAfinidadeDeterministica(topico, bases) {
  const texto = textoTopico(topico);
  const eixos = new Set(eixosDoTexto(texto));
  const tokens = tokensDeAfinidade(texto);
  let melhor = 0;

  for (const base of bases || []) {
    const baseTexto = base?.titulo || '';
    const baseEixos = new Set(eixosDoTexto(baseTexto));
    const eixosComuns = [...eixos].filter((eixo) => baseEixos.has(eixo)).length;
    const baseTokens = tokensDeAfinidade(base?.titulo || '');
    const tokensComuns = [...tokens].filter((token) => baseTokens.has(token)).length;
    let score = Math.min(70, eixosComuns * 42) + Math.min(50, tokensComuns * 14);
    if (eixosComuns === 1 && eixos.has('lideranca')) score = Math.min(score, 35);
    melhor = Math.max(melhor, score);
  }

  const meta = classificarTopico(topico);
  const potencial = Math.max(0, Math.min(100, meta.scoreViral - (meta.potencial === 'baixo' ? 25 : 0)));
  return { afinidade: Math.min(100, melhor), potencial };
}

async function consultasDoPublico(materias) {
  const titulos = (materias || [])
    .slice(0, 20)
    .map((m, i) => `${i + 1}. ${String(m.titulo || '').trim()}`)
    .filter((linha) => linha.length > 3);

  if (!titulos.length) return [];

  const fallback = sementesFallbackDoPublico(materias, 10);
  let sugeridas = [];

  try {
    const deepseekService = require('./deepseekService');
    const result = await deepseekService.sugerirConsultasPesquisa({
      pedido: [
        'Estas são as matérias que mais engajaram na minha página:',
        ...titulos,
        '',
        'Identifique os assuntos, pessoas e ângulos que esse público prefere.',
        'Crie consultas para encontrar PAUTAS NOVAS e acontecimentos recentes relacionados.',
        'Cada consulta deve manter uma pessoa, assunto específico ou padrão editorial presente nos títulos.',
        'Não use consultas amplas como apenas igreja, gospel, cristãos, religião ou evangélicos.',
        'Não procure apenas cópias ou republicações dos mesmos fatos antigos.',
      ].join('\n'),
      angulo: 'Novidades recentes com o mesmo perfil de interesse e potencial de engajamento',
    });
    if (result?.consultas?.length) sugeridas = result.consultas;
  } catch (err) {
    console.warn('[pautas-publico] consultas IA:', err.message);
  }

  const vistas = new Set();
  return [...sugeridas, ...fallback]
    .map((consulta) => String(consulta || '').replace(/\s+/g, ' ').trim())
    .filter((consulta) => {
      const key = stripAccents(consulta);
      if (consulta.length < 3 || vistas.has(key)) return false;
      vistas.add(key);
      return true;
    })
    .slice(0, 10);
}

/**
 * Encontra pautas novas a partir do que teve bom engajamento na pagina do usuario.
 * As materias antigas funcionam somente como sinais editoriais; elas nunca viram
 * pautas de repeticao diretamente.
 */
async function curarPautasDoPublico({ userId, facebookPageId, limit = 30 } = {}) {
  const AiMatters = require('../models/AiMatters');
  const lim = Math.min(30, Math.max(20, Number(limit) || 30));
  const avisos = [];

  try {
    await materiaIaService.sincronizarEngajamentoRecentes(userId, {
      limit: 40,
      concurrency: 3,
      force: true,
    });
  } catch (err) {
    avisos.push(`Engajamento: ${err.message}`);
  }

  let candidatas = await AiMatters.findViralizadasDaConta(userId, { limit: 60 });
  if (facebookPageId) {
    const alvo = Number(facebookPageId);
    const daPagina = candidatas.filter((m) => Number(m.facebook_page_id) === alvo);
    candidatas = daPagina;
  }

  const baseSanitizada = filtrarBasesComMetricasConfiaveis(candidatas);
  if (baseSanitizada.duplicadas) {
    avisos.push(`${baseSanitizada.duplicadas} matéria(s) repetida(s) na mesma publicação foram ignoradas.`);
  }
  if (baseSanitizada.suspeitas) {
    avisos.push(
      `${baseSanitizada.suspeitas} matéria(s) com métricas idênticas suspeitas foram retiradas da análise.`
    );
  }

  const basesVirais = baseSanitizada.materias
    .map((matter) => ({
      ...matter,
      classificacao: materiaIaService.classificarViral({
        fb_likes: matter.pub_fb_likes,
        fb_comments: matter.pub_fb_comments,
        fb_shares: matter.pub_fb_shares,
        fb_views: matter.pub_fb_views,
      }),
      scoreEngajamento: Math.round(scoreEngajamentoMateria(matter)),
    }))
    .filter((m) => ['alto', 'medio'].includes(m.classificacao?.nivel))
    .sort((a, b) => b.scoreEngajamento - a.scoreEngajamento)
    .slice(0, 20);

  if (!basesVirais.length) {
    const err = new Error(
      'Ainda não encontrei matérias com engajamento suficiente nesta página. Abra a aba Viralizou para atualizar os números e tente novamente.'
    );
    err.status = 422;
    err.avisos = avisos;
    throw err;
  }

  const consultas = await consultasDoPublico(basesVirais);
  if (!consultas.length) {
    const err = new Error('Não consegui identificar os assuntos preferidos do público agora.');
    err.status = 422;
    throw err;
  }

  let encontradas = [];
  for (const lote of chunk(consultas, 5)) {
    try {
      const resultado = await pesquisarNichos(lote.join(', '), 12, {
        incluirRedesSociais: false,
        filtrarPeriodo: true,
        periodo: '7d',
      });
      encontradas = encontradas.concat(resultado || []);
    } catch (err) {
      avisos.push(`Pesquisa: ${err.message}`);
    }
  }

  encontradas = dedupeTitulos(encontradas || []);
  if (!encontradas.length) {
    const err = new Error('Não encontrei notícias recentes ligadas ao que viralizou. Tente atualizar novamente mais tarde.');
    err.status = 404;
    err.avisos = avisos;
    throw err;
  }
  const marcadas = await materiaIaService.marcarJaPublicados(
    userId,
    facebookPageId,
    encontradas,
    {
      todasPaginas: true,
      incluirFeedPagina: true,
      limiteHistorico: 5000,
      limiteFeed: 300,
    }
  );
  const limiteRecente = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const timestampDoTopico = (topico) => {
    const direto = Number(topico?.dataTimestamp) || 0;
    if (direto) return direto;
    const parsed = Date.parse(String(topico?.data || topico?.dataReferencia || ''));
    if (!Number.isNaN(parsed)) return parsed;
    return extrairDataDeTexto(
      `${topico?.data || ''} ${topico?.resumo || ''} ${topico?.titulo || ''}`
    );
  };
  const novas = marcadas.filter((topico) => {
    if (topico.jaPublicado) return false;
    const ts = timestampDoTopico(topico);
    return ts >= limiteRecente && ts <= Date.now() + 24 * 60 * 60 * 1000;
  });
  const usadas = marcadas.filter((topico) => topico.jaPublicado);
  const candidatasRecentes = novas
    .map((topico) => {
      const meta = classificarTopico(topico);
      return {
        ...topico,
        ...meta,
        dataTimestamp: timestampDoTopico(topico),
      };
    })
    .filter((topico) => topico.nichoGospel && topico.temaPrincipal !== 'fora_nicho');

  const deterministicas = candidatasRecentes.map((topico) =>
    avaliarAfinidadeDeterministica(topico, basesVirais)
  );
  let avaliacoesIa = [];
  try {
    const deepseekService = require('./deepseekService');
    avaliacoesIa = await deepseekService.ranquearPautasParaPublico({
      bases: basesVirais.map((base) => ({
        titulo: base.titulo,
        likes: base.pub_fb_likes,
        comments: base.pub_fb_comments,
        shares: base.pub_fb_shares,
      })),
      pautas: candidatasRecentes,
    });
  } catch (err) {
    avisos.push(`Afinidade editorial: ${err.message}`);
  }
  const avaliacaoPorId = new Map(avaliacoesIa.map((item) => [item.id, item]));

  const topicos = candidatasRecentes
    .map((topico, index) => {
      const ia = avaliacaoPorId.get(`p${index + 1}`);
      const det = deterministicas[index];
      const afinidade = ia
        ? Math.round(ia.afinidade * 0.75 + det.afinidade * 0.25)
        : Math.round(det.afinidade);
      const potencial = ia
        ? Math.round(ia.potencial * 0.7 + det.potencial * 0.3)
        : Math.round(det.potencial);
      return {
        ...topico,
        afinidadePublico: afinidade,
        potencialPublico: potencial,
        motivoAfinidade: ia?.motivo || 'Afinidade calculada pelos temas que mais engajaram',
        scorePublico: Math.round(afinidade * 0.6 + potencial * 0.4),
      };
    })
    .filter((topico) => topico.afinidadePublico >= 55 && topico.potencialPublico >= 50)
    .sort(
      (a, b) =>
        b.scorePublico - a.scorePublico ||
        b.scoreViral - a.scoreViral ||
        (b.dataTimestamp || 0) - (a.dataTimestamp || 0)
    )
    .slice(0, lim);

  if (!topicos.length) {
    const err = new Error(
      'Não encontrei pautas do seu nicho com data confirmada nos últimos 7 dias. Atualize mais tarde para tentar novas notícias.'
    );
    err.status = 404;
    err.avisos = avisos;
    throw err;
  }

  if (usadas.length) avisos.push(`${usadas.length} pauta(s) já usada(s) foram ocultadas.`);
  if (topicos.length < 20) {
    avisos.push(
      `Foram encontradas ${topicos.length} pauta(s) realmente nova(s) nos últimos 7 dias; não completei a lista com matérias repetidas ou antigas.`
    );
  }

  return {
    topicos,
    basesVirais: basesVirais.map((m) => ({
      matterId: m.id,
      titulo: m.titulo,
      likes: Number(m.pub_fb_likes) || 0,
      comments: Number(m.pub_fb_comments) || 0,
      shares: Number(m.pub_fb_shares) || 0,
      views: Number(m.pub_fb_views) || 0,
      score: m.scoreEngajamento,
      nivel: m.classificacao?.label || 'Bom engajamento',
    })),
    consultas,
    totalAnalisado: encontradas.length,
    periodoDias: 7,
    totalOcultado: usadas.length,
    avisos,
    geradoEm: new Date().toISOString(),
  };
}

/**
 * Busca pautas automaticamente e ranqueia pelo perfil viral (só nicho gospel).
 * Conteúdo recente + busca profunda em vários termos/sites + ScrapeCreators (IG/FB).
 * Pautas já publicadas/agendadas saem da lista principal e vão em `excluidos`.
 */
async function curarPautasVirais({ userId, facebookPageId, limit = 20 } = {}) {
  const lim = Math.min(28, Math.max(5, Number(limit) || 20));
  const avisos = [];
  let brutos = [];
  let totalScrapeCreators = 0;

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

  // 3) ScrapeCreators — Reels IG (keyword) + posts de páginas FB concorrentes
  try {
    const scrapeIg = require('./scrapeCreatorsSearch');
    const scrapeFb = require('./scrapeCreatorsFacebook');

    if (scrapeIg.isConfigured()) {
      let totalIg = 0;

      // 3a) Perfis gospel do Instagram — fonte estável e sempre no nicho.
      try {
        const igRadar = require('./scrapeCreatorsInstagramRadar');
        const perfisIg = (PERFIL_VIRAL.perfisRadarIg || []).slice(0, 5);
        if (igRadar.isConfigured() && perfisIg.length) {
          const perfilResult = await igRadar.coletarTopicosDePerfis(perfisIg, {
            postsPorPerfil: 4,
            maxAgeDays: 7,
          });
          brutos = brutos.concat(perfilResult.topicos || []);
          totalIg += (perfilResult.topicos || []).length;
          if (perfilResult.avisos?.length) avisos.push(...perfilResult.avisos.slice(0, 2));
        }
      } catch (err) {
        avisos.push(`Instagram perfis: ${err.message}`);
      }

      // 3b) Busca por palavra-chave (complementa com o que está em alta).
      const igQueries = (PERFIL_VIRAL.seedsInstagram || PERFIL_VIRAL.seedsBusca).slice(0, 4);
      const igResult = await scrapeIg.buscarReelsPorQueries(igQueries, {
        datePosted: 'last-week',
        limit: 8,
      });
      brutos = brutos.concat(igResult.topicos || []);
      totalIg += (igResult.topicos || []).length;
      totalScrapeCreators += totalIg;
      if (igResult.avisos?.length) avisos.push(...igResult.avisos.slice(0, 2));
      if (totalIg) {
        avisos.push(`Instagram: ${totalIg} post(s)/reel(s) via ScrapeCreators.`);
      } else {
        avisos.push('Instagram: nenhum post retornado agora (provedor instável). Tente de novo.');
      }

      const paginas = (PERFIL_VIRAL.paginasRadarFb || []).slice(0, 5);
      const fbResult = await scrapeFb.coletarTopicosDePaginas(paginas, {
        maxAgeDays: 7,
        postsPorPagina: 3,
      });
      brutos = brutos.concat(fbResult.topicos || []);
      totalScrapeCreators += (fbResult.topicos || []).length;
      if (fbResult.avisos?.length) avisos.push(...fbResult.avisos.slice(0, 3));
      if ((fbResult.topicos || []).length) {
        avisos.push(`Facebook: ${(fbResult.topicos || []).length} post(s) de páginas gospel.`);
      }
    } else {
      avisos.push('ScrapeCreators não configurada — só notícias (Google/Brave).');
    }
  } catch (err) {
    avisos.push(`ScrapeCreators: ${err.message}`);
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
    totalScrapeCreators,
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
  const maxGerar = 20;
  const fila = lista.slice(0, maxGerar);
  const omitidos = Math.max(0, lista.length - fila.length);

  for (const topico of fila) {
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

  const extras = [];
  if (omitidos) extras.push(`${omitidos} selecionada(s) acima do limite de ${maxGerar} por vez`);
  if (erros.length) extras.push(`${erros.length} falha(s)`);

  return {
    ok: true,
    gerados,
    erros,
    total: gerados.length,
    selecionados: lista.length,
    processados: fila.length,
    omitidos,
    publicar,
    mensagem: publicar
      ? `${gerados.length} matéria(s) gerada(s) e enviada(s) para publicação.`
      : `${gerados.length} rascunho(s) em Matérias salvas — revise e publique quando quiser.` +
        (extras.length ? ` (${extras.join('; ')})` : ''),
  };
}

function normalizarLink(url) {
  return String(url || '')
    .split(/[?#]/)[0]
    .toLowerCase()
    .replace(/\/$/, '');
}

/**
 * Revalida pautas do cache contra matérias já geradas/agendadas/publicadas (só DB, sem API externa).
 * Move as já usadas para `excluidos` e mantém as livres em `topicos`.
 */
async function sincronizarPautasUsadas({
  userId,
  facebookPageId,
  topicos = [],
  excluidos = [],
} = {}) {
  const { titulosParecidos, mesmoAssuntoNoticia } = require('./editorialGuidelinesFb');
  const AiMatters = require('../models/AiMatters');

  const pool = Array.isArray(topicos) ? topicos.filter((t) => t && t.titulo) : [];
  const excluidosPrev = Array.isArray(excluidos) ? excluidos : [];

  if (!userId || !pool.length) {
    return {
      topicos: pool,
      excluidos: excluidosPrev.slice(0, 30),
      totalExcluidos: excluidosPrev.length,
      novosExcluidos: 0,
    };
  }

  const matters = await AiMatters.findByUser(userId, 300);
  const urlsUsadas = new Set();
  const titulosUsados = [];

  for (const m of matters) {
    if (facebookPageId && m.facebook_page_id && Number(m.facebook_page_id) !== Number(facebookPageId)) {
      continue;
    }
    // Qualquer matéria gerada desta fonte (rascunho → agendado → publicado)
    const statusOk = ['rascunho', 'pronto', 'agendado', 'publicado'].includes(String(m.status || ''));
    if (!statusOk && !m.publication_id) continue;

    const fonteUrl = normalizarLink(m.fonte_url);
    if (fonteUrl) urlsUsadas.add(fonteUrl);
    if (m.fonte_titulo) titulosUsados.push(m.fonte_titulo);
    if (m.titulo) titulosUsados.push(m.titulo);
  }

  const livres = [];
  const acabaramDeUsar = [];

  for (const t of pool) {
    const link = normalizarLink(t.link);
    const jaPorUrl = Boolean(link && urlsUsadas.has(link));
    const jaPorTitulo = titulosUsados.some(
      (x) =>
        mesmoAssuntoNoticia(t.titulo, x) ||
        titulosParecidos(t.titulo, x) ||
        mesmoAssuntoNoticia(String(t.resumo || '').slice(0, 120), x)
    );
    if (jaPorUrl || jaPorTitulo) {
      acabaramDeUsar.push({
        titulo: t.titulo,
        link: t.link || null,
        fonte: t.veiculo || t.fonte || null,
        motivo: 'Já gerada, agendada ou publicada nesta página',
        origemSocial: t.origemSocial || t.plataforma || null,
      });
    } else {
      livres.push({ ...t, jaPublicado: false });
    }
  }

  const seen = new Set();
  const excluidosMerged = [];
  for (const item of [...acabaramDeUsar, ...excluidosPrev]) {
    const key =
      normalizarLink(item.link) ||
      String(item.titulo || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    excluidosMerged.push(item);
  }

  return {
    topicos: livres,
    excluidos: excluidosMerged.slice(0, 40),
    totalExcluidos: excluidosMerged.length,
    novosExcluidos: acabaramDeUsar.length,
  };
}

/**
 * Desempenho das matérias já publicadas na Página padrão: ranqueia por
 * visualizações e marca o que viralizou (bem acima da mediana da própria página).
 * Leitura de banco; só busca views novas nos primeiros itens quando pedido.
 */
async function analisarDesempenhoPagina({
  userId,
  facebookPageId,
  limit = 30,
  atualizarViews = false,
} = {}) {
  const AiMatters = require('../models/AiMatters');
  const { resolvePageForUser } = require('./facebookPageResolver');

  const page = facebookPageId ? await resolvePageForUser(userId, facebookPageId) : null;
  if (!page) {
    const err = new Error('Defina a página padrão em /paginas para ver o desempenho.');
    err.status = 400;
    throw err;
  }

  const lim = Math.min(60, Math.max(5, Number(limit) || 30));
  const todas = await AiMatters.findByUserWithPub(userId, { limit: 100, status: 'publicado' });
  const daPagina = todas.filter(
    (m) => Number(m.facebook_page_id) === Number(page.id)
  );

  // Atualiza views só dos mais recentes, para não estourar a API do Facebook.
  const avisos = [];
  if (atualizarViews) {
    const materiaIa = require('./materiaIaService');
    for (const m of daPagina.slice(0, 8)) {
      try {
        const r = await materiaIa.atualizarViewsDaMateria(userId, m.id, { force: false });
        if (r?.views != null) m.pub_fb_views = r.views;
        else if (r?.message && avisos.length < 2) avisos.push(r.message);
      } catch (err) {
        if (avisos.length < 2) avisos.push(err.message);
      }
    }
  }

  const itens = daPagina.map((m) => ({
    matterId: m.id,
    titulo: m.titulo,
    tipo: m.tipo_publicacao || 'foto',
    views: m.pub_fb_views != null ? Number(m.pub_fb_views) : null,
    viewsAt: m.pub_fb_views_at || null,
    publicadoEm: m.pub_published_at || m.published_at || m.created_at,
    postUrl: m.pub_fb_post_url || null,
    editarUrl: `/materias-ia/${m.id}`,
    tema: m.fonte_titulo || null,
  }));

  const comViews = itens.filter((i) => Number.isFinite(i.views) && i.views > 0);
  const ordenadosViews = [...comViews].sort((a, b) => b.views - a.views);
  const mediana = ordenadosViews.length
    ? ordenadosViews[Math.floor(ordenadosViews.length / 2)].views
    : 0;
  const media = comViews.length
    ? Math.round(comViews.reduce((s, i) => s + i.views, 0) / comViews.length)
    : 0;
  // Viralizou = pelo menos o dobro da mediana da própria página.
  const limiarViral = mediana > 0 ? mediana * 2 : 0;

  for (const item of itens) {
    item.viralizou = Boolean(limiarViral && item.views && item.views >= limiarViral);
    item.acimaDaMedia = Boolean(media && item.views && item.views > media);
  }

  const ranking = [...itens].sort((a, b) => {
    if (b.views !== a.views) return (b.views || -1) - (a.views || -1);
    return new Date(b.publicadoEm || 0) - new Date(a.publicadoEm || 0);
  });

  const porTipo = {};
  for (const i of comViews) {
    const k = i.tipo || 'foto';
    porTipo[k] = porTipo[k] || { tipo: k, posts: 0, somaViews: 0 };
    porTipo[k].posts += 1;
    porTipo[k].somaViews += i.views;
  }
  const desempenhoPorTipo = Object.values(porTipo)
    .map((t) => ({ ...t, mediaViews: Math.round(t.somaViews / t.posts) }))
    .sort((a, b) => b.mediaViews - a.mediaViews);

  if (!itens.length) {
    avisos.push('Nenhuma matéria publicada nesta página ainda.');
  } else if (!comViews.length) {
    avisos.push(
      'Ainda sem visualizações lidas. Conecte o Facebook (OAuth) em /paginas e clique em atualizar.'
    );
  }

  return {
    pagina: { id: page.id, nome: page.page_name },
    total: itens.length,
    comViews: comViews.length,
    mediaViews: media,
    medianaViews: mediana,
    limiarViral,
    viralizaram: itens.filter((i) => i.viralizou).length,
    desempenhoPorTipo,
    itens: ranking.slice(0, lim),
    avisos,
    geradoEm: new Date().toISOString(),
  };
}

module.exports = {
  PERFIL_VIRAL,
  TAXONOMIA,
  classificarTopico,
  curarPautasVirais,
  curarPautasDoPublico,
  gerarDePautas,
  sincronizarPautasUsadas,
  analisarDesempenhoPagina,
  proximoSlotSugerido,
};
