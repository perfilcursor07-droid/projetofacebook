/**
 * Diretrizes editoriais para matérias de Página do Facebook (texto curto).
 * Adaptado de site-gospel/editorialGuidelines.js — sem HTML longo.
 */

const MAX_MATERIA_CHARS = 3500;

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
  'em meio a', 'diante do ocorrido', 'diante da repercussão',
];

function sortearFaixaChars() {
  const faixas = [
    { min: 900, max: 1400 },
    { min: 1200, max: 1800 },
    { min: 1600, max: 2400 },
    { min: 1100, max: 2000 },
  ];
  return faixas[Math.floor(Math.random() * faixas.length)];
}

function sortearEstiloLead() {
  const estilos = [
    'Abra pelo FATO direto: o que aconteceu, quem e onde, em uma frase forte.',
    'Abra pela CONSEQUÊNCIA/repercussão: o efeito que o fato causou, e só depois explique o que houve.',
    'Abra por um DETALHE concreto e específico das fontes (número, local, data, frase dita) e amarre ao fato principal.',
    'Abra pelo CONTRASTE: o que se esperava versus o que de fato aconteceu.',
    'Abra situando o LEITOR no momento: quando e onde o fato veio à tona, e por que importa agora.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearEstiloTitulo() {
  const estilos = [
    'Manchete direta e factual (sujeito + verbo + fato).',
    'Manchete com o dado ou detalhe mais forte da apuração em evidência.',
    'Manchete de duas partes separadas por ponto e vírgula ou dois-pontos (fato; desdobramento).',
    'Manchete começando pelo desdobramento ou consequência do fato.',
    'Manchete com termo-chave entre aspas simples, só se a fala/termo estiver nas fontes.',
  ];
  return estilos[Math.floor(Math.random() * estilos.length)];
}

function sortearVozRedator() {
  const vozes = [
    'Redator veterano de redação: frases secas, diretas, sem adjetivos desnecessários. Vai direto ao fato.',
    'Repórter de cotidiano: ritmo ágil, frases curtas intercaladas com uma mais longa, linguagem próxima do leitor comum.',
    'Repórter de política/religião: preciso com nomes, cargos e datas; tom sóbrio, sem dramatizar.',
    'Redator de portal popular: texto vivo e acessível, mas sem sensacionalismo; prioriza o detalhe humano do fato.',
    'Repórter analítico: conecta o fato ao seu contexto com uma observação própria, mas sem opinar; frases médias e bem encadeadas.',
  ];
  return vozes[Math.floor(Math.random() * vozes.length)];
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
  const min = faixa?.min || 900;
  const max = Math.min(faixa?.max || 2400, MAX_MATERIA_CHARS);
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

function blocoRegrasFacebook(faixa) {
  return `
DIRETRIZES FACEBOOK / PEOPLE-FIRST:
- Texto para leitor de Página, não para engajar de forma inautêntica.
- NUNCA copie fontes; reescreva 100%.
- NÃO invente fatos, números, datas, igrejas, pastores nem declarações entre aspas.
- Sem clickbait, sem pedir like/compartilhar.
- Formato: texto puro (sem HTML), parágrafos curtos separados por linha em branco.
- Extensão alvo desta geração: ${faixa.min}–${faixa.max} caracteres (máx absoluto ${MAX_MATERIA_CHARS}).
- 3 a 6 hashtags no campo hashtags (não repetir no meio do texto se já forem anexadas no fim).
- Muletas PROIBIDAS: ${FRASES_PROIBIDAS_IA.slice(0, 20).map((f) => `"${f}"`).join(', ')}…
- Feche com fato/desdobramento — nunca “como vimos” / “em suma”.`;
}

function mensagemAvisoQualidade(avaliacao) {
  if (avaliacao.curto) {
    return `Texto com ${avaliacao.chars} caracteres (alvo mín. ~${avaliacao.min}). Complemente antes de publicar.`;
  }
  if (avaliacao.longo) {
    return `Texto com ${avaliacao.chars} caracteres (alvo máx. ~${avaliacao.max}). Enxugue antes de publicar.`;
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
  mensagemAvisoQualidade,
};
