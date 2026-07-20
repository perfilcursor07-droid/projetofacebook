/**
 * Diretrizes editoriais para matérias de Página do Facebook (texto curto).
 * Adaptado de site-gospel/editorialGuidelines.js — sem HTML longo.
 *
 * Alcance no Facebook (referência 2024–2026):
 * - Pico de engajamento: ~40–80 caracteres (posts curtíssimos).
 * - “Ver mais” no mobile: ~400–480 caracteres — texto acima disso some atrás do clique.
 * - Para Página de notícias com foto: 400–700 caracteres com gancho forte no início.
 * Fontes: Hootsuite/HubSpot (≤80 chars +66% engajamento), fold ~480 chars.
 */

/**
 * Teto para Página gospel (estilo News Gospel): matérias um pouco mais longas
 * que o fold do feed, com desenvolvimento + fechamento de fé.
 */
const MAX_MATERIA_CHARS = 1200;

const FRASES_PROIBIDAS_IA = [
  'é importante ressaltar', 'vale ressaltar', 'vale destacar', 'vale lembrar',
  'nesse sentido', 'diante disso', 'em suma', 'em resumo', 'por fim',
  'além disso', 'no entanto, é', 'cabe destacar', 'é fundamental',
  'desempenha um papel', 'cenário atual', 'nos dias de hoje',
  'não podemos esquecer', 'sem dúvida', 'com certeza', 'de fato,',
  'mergulhar', 'navegar por', 'panorama geral', 'era digital',
  'reacendeu o debate', 'reacende o debate', 'acendeu o debate',
  'abalou a comunidade', 'comoveu a comunidade', 'chocou a comunidade',
  'a discussão deve continuar', 'o debate deve continuar', 'deve continuar nas próximas',
  'a discussão não é nova', 'o debate não é novo', 'não é de hoje que',
  'trajetória marcada', 'figura conhecida', 'deixa um legado',
  'ganhou as redes', 'tomou as redes', 'movimentou as redes',
  'segue repercutindo', 'resta saber', 'só o tempo dirá',
  'diante do ocorrido', 'diante da repercussão',
  'não perca', 'assista até o final', 'compartilhe com quem precisa',
  'curta e compartilhe', 'deixe seu like', 'comente aqui embaixo',
];

function sortearFaixaChars() {
  // News Gospel: desenvolvimento + aspas + fechamento de fé.
  const faixas = [
    { min: 520, max: 720 },
    { min: 580, max: 820 },
    { min: 620, max: 900 },
    { min: 550, max: 780 },
  ];
  return faixas[Math.floor(Math.random() * faixas.length)];
}

function sortearEstiloLead() {
  const estilos = [
    'Abra apresentando QUEM é a pessoa + o que ela fez/decidiu agora (ex.: ator X tem se dedicado ao chamado missionário…).',
    'Abra pelo FATO com tom de esperança ou contraste (ex.: em meio à devastação, uma notícia trouxe esperança…).',
    'Abra situando a pessoa pelo que o público já conhece (novelas, ministério, cargo) e em seguida o fato novo.',
    'Abra pelo testemunho/decisão espiritual da pessoa, já no primeiro parágrafo.',
    'Abra por um detalhe humano concreto (dias sob escombros, frase dita, lugar) e amarre ao fato principal.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearEstiloTitulo() {
  const estilos = [
    'Manchete direta e factual (sujeito + verbo + fato).',
    'Manchete com o detalhe mais forte da apuração (número, decisão, milagre, chamada).',
    'Manchete de duas partes (fato: desdobramento espiritual ou humano).',
    'Manchete curta e impactante, sem clickbait enganoso.',
    'Manchete com trecho curto entre aspas simples só se a fala estiver nas fontes.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearVozRedator() {
  const vozes = [
    'Redator de portal gospel (estilo News Gospel): jornalístico, claro e caloroso; apresenta a pessoa, conta o fato e fecha com fé — sem sensacionalismo barato.',
    'Repórter de testemunho cristão: prioriza nomes, contexto (igreja, cidade, carreira) e falas reais entre aspas; tom respeitoso e próximo do leitor.',
    'Redator de notícia com esperança: narra o fato com precisão e encerra com oração, gratidão ou reflexão espiritual natural.',
    'Cronista gospel leve: frases médias bem encadeadas, linguagem acessível, sem muletas de IA nem pedido de like.',
    'Repórter de fé e cultura: situar quem é a pessoa (TV, ministério, cargo), o que mudou e por que isso importa para a fé.',
  ];
  return vozes[Math.floor(Math.random() * vozes.length)];
}

/**
 * Critérios do estilo News Gospel — usados em vídeo, imagem, link e pauta.
 */
function blocoEstiloNewsGospel() {
  return `
ESTILO NEWS GOSPEL (obrigatório — imite a voz de Página gospel de notícias):
1) LEAD: comece apresentando quem/o quê com contexto (nome, o que a pessoa é conhecida por, cidade, ministério, carreira). Uma ou duas frases fortes.
2) DESENVOLVIMENTO: conte a história com fatos concretos (obras, datas, lugares, decisões). Use 1 a 3 FALAS LITERAIS entre aspas ("…") quando houver na fonte — introduza com "afirmou", "declarou", "contou", "disse".
3) FECHAMENTO DE FÉ: termine com reflexão espiritual, oração, gratidão ou esperança (ex.: "Que Deus console…", "Glória a Deus…", "Essa história nos lembra que…"). NUNCA feche pedindo like, comentário ou compartilhamento.
4) TOM: jornalístico + evangélico caloroso. Emocionante sem drama falso. Sem clickbait. Sem sermão genérico desconectado do fato.
5) FORMATO: 3 a 5 parágrafos curtos separados por linha em branco (\\n\\n). Texto puro. Sem HTML. Sem markdown (**negrito**). Emojis só se fizerem sentido no fechamento (no máximo 1–2), nunca no meio de cada frase.
6) PROIBIDO: colar a fonte/transcrição inteira; inventar citações; "não perca", "assista até o final", "compartilhe com quem precisa".`;
}

function sortearTemperatura(investigativa = false) {
  if (investigativa) return 0.4 + Math.random() * 0.1; // 0.40–0.50
  return 0.75 + Math.random() * 0.07; // 0.75–0.82
}

function contarChars(texto) {
  return String(texto || '').trim().length;
}

function avaliarComprimentoFb(materia, faixa) {
  const chars = contarChars(materia);
  const min = faixa?.min || 400;
  const max = Math.min(faixa?.max || 650, MAX_MATERIA_CHARS);
  return {
    chars,
    curto: chars < min * 0.85,
    longo: chars > max * 1.15 || chars > MAX_MATERIA_CHARS,
    ok: chars >= min * 0.85 && chars <= Math.min(max * 1.15, MAX_MATERIA_CHARS),
    min,
    max,
  };
}

function detectarMuletasIa(texto) {
  const lower = String(texto || '').toLowerCase();
  return FRASES_PROIBIDAS_IA.filter((f) => lower.includes(f));
}

function normalizarBusca(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Citações com nomes que não estão na apuração → possível invenção.
 */
function detectarCitacoesInventadas(materia, contextoApuracao) {
  const texto = String(materia || '');
  const contexto = normalizarBusca(contextoApuracao || '');
  const suspeitos = new Set();

  const rxNome =
    /\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s+(?:de|da|do|dos|das))?\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)\b/g;
  const rxFala =
    /[“"][^”"]{12,280}[”"][^.”"]{0,100}?(?:diz|disse|afirma|afirmou|declara|declarou|garante|garantiu|comenta|comentou)|(?:diz|disse|afirma|afirmou|declara|declarou|segundo)[^.]{0,100}?[“"][^”"]{12,280}[”"]/gi;

  const blocos = texto.match(rxFala) || [];
  for (const bloco of blocos) {
    let m;
    rxNome.lastIndex = 0;
    while ((m = rxNome.exec(bloco)) !== null) {
      const nome = m[1].trim();
      if (/^(São|Rio|Belo|Porto|Assembleia|Igreja|Santa|Santo|Nova|Google|Espírito)\b/i.test(nome)) continue;
      if (!contexto.includes(normalizarBusca(nome))) suspeitos.add(nome);
    }
  }
  return [...suspeitos];
}

function titulosParecidos(a, b) {
  const na = normalizarBusca(a)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const nb = normalizarBusca(b)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (!na.length || !nb.length) return false;
  const setB = new Set(nb);
  const inter = na.filter((w) => setB.has(w)).length;
  return inter >= Math.min(4, Math.ceil(Math.min(na.length, nb.length) * 0.55));
}

function normalizeHashtagToken(raw) {
  return String(raw || '')
    .replace(/^#/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9À-ÿ]/g, '')
    .trim();
}

function formatHashtagsLine(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const cleaned = list
    .map((t) => normalizeHashtagToken(t))
    .filter((t) => t.length >= 2)
    .slice(0, 5);
  return cleaned.map((t) => `#${t}`).join(' ');
}

/**
 * Garante hashtags no final do texto (após o corpo), sem duplicar.
 */
function anexarHashtagsAoFinal(materia, hashtags) {
  const extracted = extrairHashtagsDoTexto(materia);
  const tags =
    Array.isArray(hashtags) && hashtags.length
      ? hashtags
      : extracted.tags;
  const line = formatHashtagsLine(tags);
  const body = String(extracted.body || '').trim();
  if (!line) return body;
  return `${body}\n\n${line}`.trim();
}

/** Extrai hashtags do final do texto e devolve { body, tags }. */
function extrairHashtagsDoTexto(texto) {
  const raw = String(texto || '').replace(/\r\n/g, '\n').trim();
  const match =
    raw.match(/\n\n((?:#[\wÀ-ÿ]+(?:\s+|$))+)$/u) ||
    raw.match(/\n((?:#[\wÀ-ÿ]+(?:\s+|$))+)$/u);
  if (!match) return { body: raw, tags: [] };
  const tags = match[1]
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
  const body = raw.slice(0, match.index).trim();
  return { body, tags };
}

/**
 * Quebra texto corrido em parágrafos curtos (1–2 frases) para o feed do Facebook.
 */
function quebrarEmParagrafos(texto) {
  let t = String(texto || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';

  if (/\n\s*\n/.test(t)) {
    return t
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const sentences = t.match(/[^.!?…]+[.!?…]+(?:["”')\]]*)?|[^.!?…]+$/g) || [t];
  const paras = [];
  let buf = '';
  let frasesNoBuf = 0;

  for (const raw of sentences) {
    const piece = String(raw).replace(/\s+/g, ' ').trim();
    if (!piece) continue;
    const next = buf ? `${buf} ${piece}` : piece;
    const wouldBeLong = next.length > 240;
    if (buf && (frasesNoBuf >= 2 || wouldBeLong)) {
      paras.push(buf);
      buf = piece;
      frasesNoBuf = 1;
    } else {
      buf = next;
      frasesNoBuf += 1;
    }
  }
  if (buf) paras.push(buf);
  return paras.join('\n\n');
}

/**
 * Monta a legenda final do post: título + corpo + crédito/fonte + hashtags.
 */
function formatFacebookCaption({ titulo, materia, hashtags, fonteCredito } = {}) {
  const title = String(titulo || '').replace(/\s+/g, ' ').trim();
  const extracted = extrairHashtagsDoTexto(materia);
  let body = extracted.body;

  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    body = body.slice(title.length).replace(/^[\s:—\-–.]+/, '').trim();
  }

  body = quebrarEmParagrafos(body);

  const credit = String(fonteCredito || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  const tagsLine = formatHashtagsLine(
    Array.isArray(hashtags) && hashtags.length ? hashtags : extracted.tags
  );

  const parts = [];
  if (title) parts.push(title);
  if (body) parts.push(body);
  if (credit) parts.push(credit);
  if (tagsLine) parts.push(tagsLine);
  return parts.join('\n\n').trim();
}

/**
 * Monta crédito padrão da matéria (editável depois).
 * Ex.: "Fonte: G1" + "(Foto: Reprodução)"
 */
function montarFonteCredito({ veiculo, fonte, host, tipoPublicacao, imagemOrigem } = {}) {
  let nome = String(veiculo || fonte || '').replace(/\s+/g, ' ').trim();
  if (!nome && host) {
    try {
      const hostname = String(host).includes('://') ? new URL(host).hostname : host;
      nome = String(hostname)
        .replace(/^www\./i, '')
        .split('.')[0]
        .replace(/[-_]/g, ' ')
        .trim();
      if (nome) nome = nome.charAt(0).toUpperCase() + nome.slice(1);
    } catch {
      /* ignore */
    }
  }
  const genericos = /^(fonte|google news|brave|editorial|serpapi|pexels)$/i;
  const lines = [];
  if (nome && !genericos.test(nome)) {
    lines.push(`Fonte: ${nome}`);
  }

  const temFoto = tipoPublicacao === 'foto' || Boolean(imagemOrigem);
  if (temFoto) {
    lines.push(imagemOrigem?.tipo === 'pexels' ? '(Foto: Pexels)' : '(Foto: Reprodução)');
  }

  return lines.join('\n').slice(0, 400) || null;
}

function blocoRegrasFacebook(faixa) {
  return `
DIRETRIZES FACEBOOK / PEOPLE-FIRST:
- Texto para leitor de Página gospel, não para engajar de forma inautêntica.
- NÃO copie a fonte inteira; reescreva a narrativa com estrutura própria.
- FALAS LITERAIS: quando a apuração trouxer fala/transcrição/legendas, DEIXE 1 a 3 trechos curtos e fortes entre aspas ("…") — fiéis ao que foi dito. Introduza com "afirmou", "declarou", "contou".
- NÃO invente fatos, números, datas, igrejas, pastores nem declarações entre aspas que NÃO estejam nas fontes.
- Sem clickbait, sem pedir like/compartilhar/"não perca"/"assista até o final".
- Formato OBRIGATÓRIO: 3 a 5 parágrafos curtos separados por linha em branco (\\n\\n). Nunca um bloco único.
- Gancho forte nos primeiros ~120 caracteres (quem + fato).
- Extensão alvo desta geração: ${faixa.min}–${faixa.max} caracteres (máx absoluto ${MAX_MATERIA_CHARS}).
- 3 a 5 hashtags no campo hashtags, SEM espaços internos (ex.: FeCrista), sem # no valor.
- Muletas PROIBIDAS: ${FRASES_PROIBIDAS_IA.slice(0, 22).map((f) => `"${f}"`).join(', ')}…
- FECHAMENTO: reflexão de fé, oração ou gratidão ligada ao fato — nunca “como vimos” / “em suma” / CTA de engajamento.

${blocoEstiloNewsGospel()}`;
}

function mensagemAvisoQualidade(avaliacao) {
  if (avaliacao.curto) {
    return `Texto com ${avaliacao.chars} caracteres (alvo mín. ~${avaliacao.min}). Complemente antes de publicar.`;
  }
  if (avaliacao.longo) {
    return `Texto com ${avaliacao.chars} caracteres (alvo máx. ~${avaliacao.max} para melhor alcance no feed). Enxugue antes de publicar.`;
  }
  return null;
}

module.exports = {
  MAX_MATERIA_CHARS,
  FRASES_PROIBIDAS_IA,
  sortearFaixaChars,
  sortearEstiloLead,
  sortearEstiloTitulo,
  sortearVozRedator,
  sortearTemperatura,
  contarChars,
  avaliarComprimentoFb,
  detectarMuletasIa,
  detectarCitacoesInventadas,
  titulosParecidos,
  normalizarBusca,
  blocoRegrasFacebook,
  blocoEstiloNewsGospel,
  mensagemAvisoQualidade,
  formatFacebookCaption,
  montarFonteCredito,
  quebrarEmParagrafos,
  formatHashtagsLine,
  anexarHashtagsAoFinal,
  extrairHashtagsDoTexto,
};
