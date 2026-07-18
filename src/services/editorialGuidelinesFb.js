/**
 * Diretrizes editoriais para matérias de Página do Facebook / Instagram.
 * Regra de tamanho: sempre mirar o TETO útil do feed (Face + Insta).
 * - Fonte longa → condensar preservando os dados principais.
 * - Fonte curta → ampliar com contexto real da apuração.
 */

/**
 * Teto do corpo + créditos + hashtags (limite prático Face/Insta).
 * Instagram caption ≈ 2200; usamos isso como referência dura.
 */
const MAX_MATERIA_CHARS = 2200;

/** Alvo do corpo da minimatéria (sem hashtags/créditos). Sempre perto do máximo. */
const FAIXA_CORPO_FB = Object.freeze({ min: 1700, max: 2100 });

/** Abaixo disso a fonte é tratada como “texto pequeno” (precisa expandir). */
const FONTE_CURTA_CHARS = 700;
/** Acima disso a fonte é “texto grande” (precisa condensar). */
const FONTE_LONGA_CHARS = 1800;

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
  // Sempre o mesmo alvo: tamanho máximo útil para Face/Insta.
  return { min: FAIXA_CORPO_FB.min, max: FAIXA_CORPO_FB.max };
}

/**
 * Classifica o volume da fonte para orientar condensar × expandir.
 * @returns {'curta'|'media'|'longa'}
 */
function classificarVolumeFonte(textoFonte) {
  const n = contarChars(textoFonte);
  if (n <= FONTE_CURTA_CHARS) return 'curta';
  if (n >= FONTE_LONGA_CHARS) return 'longa';
  return 'media';
}

function blocoRegraTamanhoAdaptativo(faixa, volumeFonte) {
  const alvo = `${faixa.min}–${faixa.max}`;
  if (volumeFonte === 'longa') {
    return `TAMANHO (fonte LONGA — CONDENSE):
- A apuração é extensa. CONDENSE até ${alvo} caracteres (máx. Face/Insta).
- Preserve TODOS os dados principais: nomes, números, datas, lugares, decisões e 1–3 falas literais.
- Corte só repetição, enrolação e detalhes secundários — nunca o furo.
- O texto final deve chegar PERTO do máximo (${faixa.max}), não ficar telegráfico.`;
  }
  if (volumeFonte === 'curta') {
    return `TAMANHO (fonte CURTA — AMPLIE):
- A apuração é curta. AMPLIE até ${alvo} caracteres (máx. Face/Insta).
- Use só contexto REAL da apuração: quem é a pessoa, o que já se sabe dela, lugar, ministério/carreira, desdobramento e fechamento de fé.
- NÃO invente fatos, números, cargos nem citações.
- O texto final deve chegar PERTO do máximo (${faixa.max}) — matéria completa, não bilhete.`;
  }
  return `TAMANHO (fonte MÉDIA — COMPLETE):
- Reescreva a narrativa e preencha até ${alvo} caracteres (máx. Face/Insta).
- Preserve os dados principais e desenvolva com contexto real da apuração.
- Meta: perto de ${faixa.max} caracteres no corpo.`;
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
ESTILO NEWS GOSPEL — MINIMATÉRIA (obrigatório):
1) LEAD: apresente quem/o quê com contexto (nome, o que a pessoa é conhecida por, cidade, ministério, carreira). Uma ou duas frases fortes.
2) DESENVOLVIMENTO: minimatéria do conteúdo original. Se a fonte for grande, condense preservando os dados principais; se for pequena, complete com contexto real da apuração — sempre no tamanho máximo Face/Insta.
3) Use 1 a 3 FALAS LITERAIS entre aspas ("…") quando houver na fonte — introduza com "afirmou", "declarou", "contou", "disse".
4) FECHAMENTO DE FÉ: reflexão espiritual, oração, gratidão ou esperança. NUNCA peça like/comentário/compartilhamento.
5) TOM: jornalístico + evangélico caloroso. Sem clickbait.
6) FORMATO: 5 a 8 parágrafos curtos separados por linha em branco (\\n\\n). Texto puro. Sem HTML/markdown. Emojis só no fechamento (máx. 1–2).
7) PROIBIDO: colar a fonte inteira; inventar citações; "não perca", "assista até o final", "compartilhe com quem precisa".
8) NÃO coloque bloco de "Fontes:" no JSON — o sistema anexa créditos automaticamente.`;
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
 * Monta a legenda final do post: título + corpo em parágrafos + hashtags, com espaços.
 */
function formatFacebookCaption({ titulo, materia, hashtags } = {}) {
  const title = String(titulo || '').replace(/\s+/g, ' ').trim();
  const extracted = extrairHashtagsDoTexto(materia);
  let body = extracted.body;

  if (title && body.toLowerCase().startsWith(title.toLowerCase())) {
    body = body.slice(title.length).replace(/^[\s:—\-–.]+/, '').trim();
  }

  body = quebrarEmParagrafos(body);

  const tagsLine = formatHashtagsLine(
    Array.isArray(hashtags) && hashtags.length ? hashtags : extracted.tags
  );

  const parts = [];
  if (title) parts.push(title);
  if (body) parts.push(body);
  if (tagsLine) parts.push(tagsLine);
  return parts.join('\n\n').trim();
}

/** Crédito padrão quando a imagem interna não traz autor identificável. */
const CREDITO_IMAGEM_FALLBACK = 'Reprodução/Internet';

/**
 * Extrai nome de autor/fotógrafo dos metadados da imagem interna (heurística).
 * Retorna null se não houver nome claro (aí cai no fallback ou na IA).
 */
function extrairAutorImagemHeuristico({ autor, fonte, titulo } = {}) {
  const limpar = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
      .slice(0, 80);

  const pareceAutor = (s) => {
    const v = limpar(s);
    if (!v || v.length < 2 || v.length > 80) return false;
    if (/^(pexels|unsplash|getty|shutterstock|google|internet|reprodu[cç][aã]o|reprodu[cç][aã]o\/internet|stock|foto|image|imagem)$/i.test(v)) {
      return false;
    }
    if (/^(instagram|facebook|twitter|x|tiktok|youtube|g1|uol|globo|bbc|cnn|reuters)$/i.test(v)) {
      return false;
    }
    if (/\.(com|br|net|org|io)\b/i.test(v)) return false;
    return true;
  };

  const a = limpar(autor);
  if (pareceAutor(a)) return a;

  const f = limpar(fonte);
  const pexels = f.match(/^Pexels\s*[·\-–|]\s*(.+)$/i);
  if (pexels && pareceAutor(pexels[1])) return limpar(pexels[1]);
  if (pareceAutor(f) && /\b[\p{Lu}][\p{L}'’.-]{1,}(?:\s+[\p{Lu}][\p{L}'’.-]{1,})+/u.test(f)) {
    return f;
  }

  const t = String(titulo || '');
  const tm =
    t.match(
      /(?:foto|fotografia|cr[eé]dito|photographer|photo\s*by|by|por)\s*[:：\-–]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\- ]{1,60})/i
    ) || t.match(/©\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.\- ]{1,60})/i);
  if (tm && pareceAutor(tm[1])) {
    return limpar(tm[1].replace(/\s*[|/·].*$/, ''));
  }

  return null;
}

/** Nome amigável do site a partir da URL (sem link). */
function nomeSiteDeUrl(url) {
  try {
    const host = new URL(String(url || '').trim()).hostname.replace(/^www\./i, '');
    if (!host) return null;
    const base = host.split('.')[0] || host;
    const conhecidos = {
      g1: 'G1',
      uol: 'UOL',
      globo: 'Globo',
      folha: 'Folha',
      estadao: 'Estadão',
      cnn: 'CNN',
      bbc: 'BBC',
      youtube: 'YouTube',
      instagram: 'Instagram',
      facebook: 'Facebook',
      tiktok: 'TikTok',
      twitter: 'X',
      x: 'X',
    };
    if (conhecidos[base.toLowerCase()]) return conhecidos[base.toLowerCase()];
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return null;
  }
}

/**
 * Anexa bloco de créditos (origem do conteúdo + crédito da imagem) antes das hashtags.
 * Conteúdo: somente o nome do site (sem URL).
 * Imagem: só o nome do autor, ou "Reprodução/Internet" se não houver.
 */
function anexarCreditosFontes(materia, { fonteNome, fonteUrl, imagemAutor } = {}) {
  const { body, tags } = extrairHashtagsDoTexto(materia);
  let cleanBody = String(body || '')
    .replace(/\n*Fontes:\s*\n(?:[•\-*].+\n?)+$/i, '')
    .trim();

  const linhas = [];
  let site = String(fonteNome || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  // Se veio URL no nome, ou nome vazio, usa o host amigável
  if (!site || /^https?:\/\//i.test(site)) {
    site = nomeSiteDeUrl(fonteUrl || site) || '';
  } else if (/^https?:\/\//i.test(String(fonteUrl || ''))) {
    // Nome genérico demais → prefere host
    if (/^(site|fonte|not[ií]cia|post|link)$/i.test(site)) {
      site = nomeSiteDeUrl(fonteUrl) || site;
    }
  }
  if (site) linhas.push(`• Conteúdo: ${site}`);

  const creditoImg = limparCreditoAutor(imagemAutor);
  linhas.push(`• Imagem: ${creditoImg}`);

  const bloco = `Fontes:\n${linhas.join('\n')}`;
  return anexarHashtagsAoFinal(`${cleanBody}\n\n${bloco}`, tags);
}

function limparCreditoAutor(value) {
  const v = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v || /^reprodu[cç][aã]o(\/internet)?$/i.test(v) || /^internet$/i.test(v)) {
    return CREDITO_IMAGEM_FALLBACK;
  }
  return v.slice(0, 80);
}

/** Atualiza só a linha de crédito da imagem no bloco Fontes (mantém Conteúdo e hashtags). */
function atualizarCreditoImagemNaMateria(materia, imagemAutor) {
  const credito = limparCreditoAutor(imagemAutor);
  const { body, tags } = extrairHashtagsDoTexto(materia);
  let cleanBody = String(body || '').trim();

  if (/Fontes:\s*\n(?:[•\-*].+\n?)+$/i.test(cleanBody)) {
    if (/[•\*]\s*Imagem\s*:/i.test(cleanBody)) {
      cleanBody = cleanBody.replace(/([•\*]\s*Imagem\s*:\s*)([^\n]+)/i, `$1${credito}`);
    } else {
      cleanBody = cleanBody.replace(/(Fontes:\s*\n(?:[•\*].+\n?)*)/i, (m) => `${m.trimEnd()}\n• Imagem: ${credito}\n`);
    }
    return anexarHashtagsAoFinal(cleanBody, tags);
  }

  return anexarCreditosFontes(cleanBody, { imagemAutor: credito });
}

function blocoRegrasFacebook(faixa, volumeFonte = 'media') {
  return `
DIRETRIZES FACEBOOK + INSTAGRAM / MINIMATÉRIA:
- Meta de tamanho: SEMPRE o máximo útil do feed (${faixa.min}–${faixa.max} chars no corpo; teto ${MAX_MATERIA_CHARS} com créditos/hashtags).
- Fonte longa → condensar preservando dados principais. Fonte curta → ampliar com contexto real. Nunca ficar muito abaixo do máximo.
- NÃO copie a fonte inteira; reescreva com estrutura própria.
- FALAS LITERAIS: 1 a 3 trechos curtos entre aspas ("…") quando houver na apuração.
- NÃO invente fatos, números, datas, igrejas, pastores nem declarações.
- Sem clickbait, sem pedir like/compartilhar/"não perca"/"assista até o final".
- Formato: 5 a 8 parágrafos curtos separados por linha em branco (\\n\\n).
- Gancho forte nos primeiros ~120 caracteres (quem + fato).
- 3 a 5 hashtags no campo hashtags, SEM espaços internos, sem # no valor.
- Muletas PROIBIDAS: ${FRASES_PROIBIDAS_IA.slice(0, 22).map((f) => `"${f}"`).join(', ')}…
- FECHAMENTO: fé/oração/gratidão — nunca CTA de engajamento.

${blocoRegraTamanhoAdaptativo(faixa, volumeFonte)}

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
  FAIXA_CORPO_FB,
  FONTE_CURTA_CHARS,
  FONTE_LONGA_CHARS,
  FRASES_PROIBIDAS_IA,
  sortearFaixaChars,
  classificarVolumeFonte,
  blocoRegraTamanhoAdaptativo,
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
  quebrarEmParagrafos,
  formatHashtagsLine,
  anexarHashtagsAoFinal,
  anexarCreditosFontes,
  atualizarCreditoImagemNaMateria,
  extrairAutorImagemHeuristico,
  limparCreditoAutor,
  CREDITO_IMAGEM_FALLBACK,
  extrairHashtagsDoTexto,
};
