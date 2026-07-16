const axios = require('axios');
const { env } = require('../config/env');
const {
  MAX_MATERIA_CHARS,
  sortearFaixaChars,
  sortearEstiloLead,
  sortearEstiloTitulo,
  sortearVozRedator,
  sortearTemperatura,
  avaliarComprimentoFb,
  detectarMuletasIa,
  detectarCitacoesInventadas,
  blocoRegrasFacebook,
  mensagemAvisoQualidade,
  quebrarEmParagrafos,
} = require('./editorialGuidelinesFb');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

function assertDeepseek() {
  if (!env.deepseekApiKey) {
    const err = new Error('DEEPSEEK_API_KEY não configurada no .env');
    err.status = 500;
    throw err;
  }
}

async function chatCompletion(messages, { temperature = 0.78, json = true } = {}) {
  assertDeepseek();
  const { data } = await axios.post(
    DEEPSEEK_URL,
    {
      model: DEEPSEEK_MODEL,
      temperature,
      response_format: json ? { type: 'json_object' } : undefined,
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${env.deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 90_000,
    }
  );

  const raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) {
    const err = new Error('DeepSeek retornou resposta vazia');
    err.status = 502;
    throw err;
  }
  return raw;
}

function parseArtigoJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('DeepSeek retornou resposta inválida');
    err.status = 502;
    throw err;
  }
  const titulo = String(parsed.titulo || '').trim();
  let materia = String(parsed.materia || parsed.conteudo || '').trim();
  // Facebook: texto puro — remove HTML residual, mas PRESERVA parágrafos (\\n\\n)
  materia = materia
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  materia = quebrarEmParagrafos(materia);
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 5)
    : [];
  const termosImagem = Array.isArray(parsed.termos_imagem)
    ? parsed.termos_imagem.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
    : [];

  if (!materia) {
    const err = new Error('DeepSeek não gerou a matéria');
    err.status = 502;
    throw err;
  }

  // Não cola hashtags no corpo aqui — formatFacebookCaption faz isso na publicação/exibição
  if (materia.length > MAX_MATERIA_CHARS) {
    materia = `${materia.slice(0, MAX_MATERIA_CHARS - 1).trim()}…`;
  }
  return { titulo, materia, hashtags, termos_imagem: termosImagem };
}

const SYSTEM_PROMPT_VIDEO = `Você é um redator de Páginas do Facebook. Escreva matérias/legendas ORIGINAIS em português brasileiro.

Regras obrigatórias (Facebook / monetização / anti-plágio):
- NÃO cole a transcrição inteira nem parafraseie frase a frase. Estruture como matéria de Página (gancho + desenvolvimento + fechamento).
- DEIXE 1 a 3 FALAS LITERAIS do vídeo entre aspas ("…"), curtas e marcantes — exatamente como foram ditas (ou o trecho mais fiel da transcrição). Isso evita texto genérico.
- O resto do texto é seu: contextualize quem falou, o que motivou e o impacto. Não invente falas que não estejam na transcrição.
- Não invente fatos, números, nomes ou eventos que não estejam na fonte.
- Sem clickbait enganoso, sem pedir likes/compartilhamentos de forma inautêntica.
- Tom de matéria jornalística leve, clara e pública (adequada a Página do Facebook).
- Não inclua links externos desnecessários nem música/copyright de terceiros.
- Inclua 3 a 6 hashtags relevantes no campo hashtags (sem # duplicado no texto).
- A matéria final deve ter no máximo ${MAX_MATERIA_CHARS} caracteres.
- Responda APENAS com JSON válido, sem markdown: {"titulo":"...","materia":"...","hashtags":["..."]}`;

async function chatJson(userContent, temperature = 0.78) {
  const raw = await chatCompletion(
    [
      { role: 'system', content: SYSTEM_PROMPT_VIDEO },
      { role: 'user', content: userContent },
    ],
    { temperature, json: true }
  );
  return parseArtigoJson(raw);
}

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detecta se a matéria é só (ou quase) a transcrição colada. */
function materiaCopiaTranscricao(materia, transcricao) {
  const a = normalizeForCompare(materia);
  const b = normalizeForCompare(transcricao);
  if (!a || !b || b.length < 40) return false;
  if (a === b) return true;
  if (a.includes(b.slice(0, Math.min(120, b.length)))) return true;
  if (b.includes(a.slice(0, Math.min(120, a.length))) && a.length > b.length * 0.7) return true;

  const wordsA = new Set(a.split(' ').filter((w) => w.length > 3));
  const wordsB = b.split(' ').filter((w) => w.length > 3);
  if (wordsB.length < 12) return false;
  let hit = 0;
  for (const w of wordsB) {
    if (wordsA.has(w)) hit += 1;
  }
  return hit / wordsB.length >= 0.72;
}

function isTranscricaoInutil(transcricao) {
  const t = String(transcricao || '').trim();
  if (!t) return true;
  if (/^\[(sem fala|falha)/i.test(t)) return true;
  // Aceita legenda curta do FB/IG (manchete) — melhor que falhar sem Whisper
  return t.length < 12;
}

async function gerarMateriaVideo({ transcricao, titulo, tema, idioma }) {
  if (isTranscricaoInutil(transcricao)) {
    const err = new Error(
      'Não há fala útil neste clipe. Informe um tema e tente de novo, ou use um vídeo com narração/voz.'
    );
    err.status = 422;
    throw err;
  }

  const basePrompt = [
    'Crie uma matéria/legenda ORIGINAL para um Reel no Facebook.',
    'A base abaixo é a FALA do vídeo (transcrição) OU a legenda original do post no Facebook/Instagram — use SOMENTE esse conteúdo. Não invente fatos fora dele.',
    'PROIBIDO colar a transcrição/legenda inteira. Reescreva a narrativa como redator de Página.',
    'OBRIGATÓRIO: inclua 1 a 3 falas literais curtas da base entre aspas ("assim"), as frases mais fortes ou características do que foi dito.',
    'Exemplo de uso: Ele afirma: "não basta carregar um sobrenome". Depois contextualize com suas palavras.',
    'Estrutura: gancho (1 frase) + desenvolvimento com aspas + fechamento + hashtags.',
    'O campo "titulo" deve ser uma MANCHETE CURTA (máx. 90 caracteres) — NÃO cole a legenda/transcrição inteira no título.',
    tema ? `Ângulo / tipo de matéria pedido pelo usuário: ${tema}` : null,
    titulo ? `Título/contexto do vídeo de origem: ${String(titulo).slice(0, 120)}` : null,
    idioma ? `Idioma detectado da fala: ${idioma}` : null,
    'Base (transcrição da fala ou legenda do Reel FB/IG — use trechos curtos entre aspas; o restante reescreva):',
    '---',
    String(transcricao).slice(0, 8000),
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  let artigo = await chatJson(basePrompt, sortearTemperatura(false));

  if (materiaCopiaTranscricao(artigo.materia, transcricao)) {
    const retryPrompt = [
      basePrompt,
      '',
      'ALERTA: sua resposta anterior ficou quase igual à transcrição inteira.',
      'Reescreva a estrutura e a maior parte do texto com palavras novas.',
      'Mantenha apenas 1–3 frases curtas entre aspas ("…") tiradas da fala — o resto NÃO pode ser cópia.',
    ].join('\n');
    artigo = await chatJson(retryPrompt, 0.9);
  }

  if (materiaCopiaTranscricao(artigo.materia, transcricao)) {
    const err = new Error(
      'A IA devolveu texto muito parecido com a transcrição. Clique em Gerar matéria de novo ou informe um tema.'
    );
    err.status = 502;
    throw err;
  }

  // Garante manchete curta mesmo se o modelo exagerar
  if (artigo?.titulo) {
    artigo.titulo = String(artigo.titulo).replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  return artigo;
}

async function gerarMateriaImagem({ promptUsuario, descricaoImagem, autor, termo }) {
  const tema = String(promptUsuario || '').trim();
  if (!tema) {
    const err = new Error('Informe o tipo/tema da matéria (ex.: curiosidade, dica, notícia)');
    err.status = 400;
    throw err;
  }

  const userContent = [
    'Crie uma matéria/legenda ORIGINAL para um post de FOTO no Facebook.',
    `Tipo/tema pedido pelo usuário: ${tema}`,
    termo ? `Termo de busca / contexto: ${termo}` : null,
    descricaoImagem ? `Descrição/alt da imagem: ${descricaoImagem}` : null,
    autor ? `Autor da foto (crédito se fizer sentido): ${autor}` : null,
    'A imagem acompanha o texto no mesmo post — escreva como legenda/matéria completa e autêntica.',
  ]
    .filter(Boolean)
    .join('\n');

  return chatJson(userContent, sortearTemperatura(false));
}

function systemPromptNoticia(faixa, investigativa, furoReportagem = false) {
  return `Você é redator de Páginas do Facebook. Escreva matérias ORIGINAIS em português brasileiro.

${blocoRegrasFacebook(faixa)}

Formato Facebook (obrigatório):
- Campo "materia" = texto puro da legenda/matéria (SEM HTML, SEM meta description, SEM keywords SEO).
- Campo "hashtags" = 3 a 6 termos sem #.
- Campo "termos_imagem" = 2 a 4 consultas específicas para encontrar uma foto realmente relacionada.
  - Se houver pessoas, use primeiro os nomes completos e exatos em português (ex.: ["Silas Malafaia Flávio Bolsonaro","Silas Malafaia","Flávio Bolsonaro"]).
  - Não troque pessoas citadas por conceitos genéricos como "church", "politics" ou "gospel".
  - Use termos de stock em inglês somente quando a pauta não citar pessoa, organização ou lugar específico.
- NÃO invente fatos, nomes, cargos, números ou citações que não estejam nas fontes de apuração.

${investigativa ? 'MODO INVESTIGATIVO: use SOMENTE evidências documentadas; temperatura baixa de criatividade; zero dramatização.' : ''}
${furoReportagem ? `MODO FURO DE REPORTAGEM (obrigatório):
- A fonte é uma notícia/post/vídeo já publicado. Você NÃO resume nem parafraseia parágrafo a parágrafo.
- Encontre o FURO: o ângulo mais jornalístico e específico (o detalhe, a consequência, o conflito ou o desdobramento que o leitor não vê no lead genérico).
- Reescreva com estrutura própria (lead + desenvolvimento + fechamento). Ordem e a maior parte das frases diferentes da fonte.
- OBRIGATÓRIO: preserve 1 a 3 falas literais curtas entre aspas ("…") quando houver declaração, frase de efeito ou trecho dito no vídeo/post — exatamente como na apuração. Sem isso o texto fica genérico.
- Título próprio — nunca copie a manchete da fonte (pode usar um trecho curto entre aspas simples no título se for a fala-chave).
- Mantenha todos os fatos verificáveis da apuração; sem inventar exclusividade falsa (“revelamos”, “apuração exclusiva”) se não houver.
- Cite o veículo só de forma genérica se necessário (“segundo informações divulgadas”).` : ''}

Responda APENAS JSON válido: {"titulo":"...","materia":"...","hashtags":["..."],"termos_imagem":["..."]}`;
}

/**
 * Matéria a partir de pauta/notícia apurada + sorteios anti-padronização + quality gate.
 */
async function gerarMateriaNoticiaFacebook({
  tituloReferencia,
  resumoReferencia,
  fonte,
  nicho,
  contextoApuracao,
  fontesApuracao,
  dataReferencia,
  emAlta,
  redeSocial,
  investigativa = false,
  furoReportagem = false,
}) {
  assertDeepseek();

  const faixa = sortearFaixaChars();
  const voz = sortearVozRedator();
  const lead = sortearEstiloLead();
  const estiloTitulo = sortearEstiloTitulo();
  const temperature = furoReportagem
    ? 0.72 + Math.random() * 0.08
    : sortearTemperatura(investigativa);
  const systemMsg = systemPromptNoticia(faixa, investigativa, furoReportagem);

  const fontesTxt = Array.isArray(fontesApuracao) && fontesApuracao.length
    ? fontesApuracao
        .slice(0, 5)
        .map((f, i) => {
          return [
            `Fonte ${i + 1}: ${f.veiculo || 'Veículo'}`,
            f.url ? `URL: ${f.url}` : null,
            f.titulo ? `Título: ${f.titulo}` : null,
            f.resumo ? `Resumo: ${f.resumo}` : null,
            f.trecho ? `Trecho documentado: ${String(f.trecho).slice(0, 1200)}` : null,
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n')
    : '';

  const materialApuracao = [
    contextoApuracao,
    tituloReferencia,
    resumoReferencia,
    fontesTxt,
  ]
    .filter(Boolean)
    .join('\n');

  const userContent = [
    'Crie uma matéria ORIGINAL para postar na Página do Facebook (texto/foto + legenda).',
    `VOZ DO REDATOR (obrigatório seguir nesta geração): ${voz}`,
    `ESTILO DO LEAD: ${lead}`,
    `ESTILO DO TÍTULO: ${estiloTitulo}`,
    `EXTENSÃO ALVO: ${faixa.min}–${faixa.max} caracteres (curto = mais alcance no feed).`,
    'FORMATAÇÃO: use parágrafos curtos separados por linha em branco. Gancho forte na 1ª frase.',
    nicho ? `Nicho/palavras-chave: ${nicho}` : null,
    emAlta ? 'Contexto: assunto em alta agora.' : null,
    redeSocial
      ? 'A fonte é post/vídeo de rede social. Transforme em matéria de Página: contextualize com suas palavras, mas DEIXE 1–3 falas literais curtas entre aspas ("…") tiradas do texto/transcrição da apuração — as frases mais fortes do autor do vídeo.'
      : null,
    furoReportagem
      ? 'PRIORIDADE: ângulo de furo de reportagem + reescrita total. Não parafraseie a fonte; reconstrua a narrativa.'
      : null,
    tituloReferencia ? `Título de referência: ${tituloReferencia}` : null,
    resumoReferencia ? `Resumo de referência: ${resumoReferencia}` : null,
    fonte ? `Fonte citada genericamente: ${fonte}` : null,
    dataReferencia ? `Data da fonte: ${dataReferencia}` : null,
    contextoApuracao ? `Contexto de apuração:\n${String(contextoApuracao).slice(0, 6000)}` : null,
    fontesTxt ? `Fontes documentadas:\n${fontesTxt}` : null,
    'Se faltar detalhe factual, generalise com cuidado (ex.: “segundo informações divulgadas”) sem inventar.',
    'Quando houver fala documentada na apuração, use aspas em pelo menos uma frase literal no corpo da matéria.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let artigo = parseArtigoJson(
    await chatCompletion(
      [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userContent },
      ],
      { temperature, json: true }
    )
  );

  let qualidade = avaliarComprimentoFb(artigo.materia, faixa);

  if (qualidade.curto) {
    try {
      const expandido = await chatCompletion(
        [
          { role: 'system', content: systemMsg },
          {
            role: 'user',
            content: `Matéria CURTA (${qualidade.chars} caracteres). Expanda para ${faixa.min}–${faixa.max} caracteres SEM inventar fatos nem muletas de IA. Mantenha o mesmo ângulo.

MATÉRIA:
${JSON.stringify(artigo)}

Retorne JSON completo atualizado.`,
          },
        ],
        { temperature: Math.min(temperature, 0.7), json: true }
      );
      artigo = parseArtigoJson(expandido);
      qualidade = avaliarComprimentoFb(artigo.materia, faixa);
    } catch (e) {
      console.warn('Expandir matéria curta:', e.message);
    }
  }

  if (qualidade.longo) {
    try {
      const enxuto = await chatCompletion(
        [
          { role: 'system', content: systemMsg },
          {
            role: 'user',
            content: `Matéria LONGA (${qualidade.chars} caracteres). Enxugue para ${faixa.min}–${faixa.max} (máx ${MAX_MATERIA_CHARS}). Remova repetições. Mantenha o furo e os fatos.

MATÉRIA:
${JSON.stringify(artigo)}

Retorne JSON completo enxuto.`,
          },
        ],
        { temperature: 0.65, json: true }
      );
      artigo = parseArtigoJson(enxuto);
      qualidade = avaliarComprimentoFb(artigo.materia, faixa);
    } catch (e) {
      console.warn('Encurtar matéria longa:', e.message);
    }
  }

  const muletas = detectarMuletasIa(artigo.materia);
  const citacoesSuspeitas = detectarCitacoesInventadas(artigo.materia, materialApuracao);

  if (muletas.length >= 2 || citacoesSuspeitas.length) {
    const problemas = [];
    if (citacoesSuspeitas.length) {
      problemas.push(
        `CITAÇÕES/NOMES POSSIVELMENTE INVENTADOS: ${citacoesSuspeitas.map((n) => `"${n}"`).join(', ')} — REMOVA as falas entre aspas e relate de forma indireta, sem inventar pessoas.`
      );
    }
    if (muletas.length) {
      problemas.push(
        `MULETAS DE IA: ${muletas.map((m) => `"${m}"`).join(', ')} — reescreva só as frases problemáticas com voz natural.`
      );
    }

    try {
      const humanizado = await chatCompletion(
        [
          { role: 'system', content: systemMsg },
          {
            role: 'user',
            content: `Revise a matéria corrigindo os problemas. Mantenha FATOS REAIS. Não adicione "vale ressaltar", "além disso", "em suma".

PROBLEMAS:
${problemas.map((p, i) => `${i + 1}. ${p}`).join('\n')}

MATÉRIA:
${JSON.stringify(artigo)}

Retorne JSON completo atualizado.`,
          },
        ],
        { temperature: 0.7, json: true }
      );
      const candidato = parseArtigoJson(humanizado);
      const aindaMuletas = detectarMuletasIa(candidato.materia);
      const aindaCitacoes = detectarCitacoesInventadas(candidato.materia, materialApuracao);
      if (
        candidato.materia &&
        aindaMuletas.length <= muletas.length &&
        aindaCitacoes.length <= citacoesSuspeitas.length
      ) {
        artigo = candidato;
        qualidade = avaliarComprimentoFb(artigo.materia, faixa);
      }
    } catch (e) {
      console.warn('Humanizar matéria:', e.message);
    }
  }

  return {
    ...artigo,
    _chars: qualidade.chars,
    _qualidadeOk: qualidade.ok,
    _avisoQualidade: mensagemAvisoQualidade(qualidade),
    _muletasIa: detectarMuletasIa(artigo.materia),
    _citacoesSuspeitas: detectarCitacoesInventadas(artigo.materia, materialApuracao),
    _estilo: {
      voz: voz.slice(0, 60),
      lead: lead.slice(0, 60),
      titulo: estiloTitulo.slice(0, 60),
      faixa,
      temperature: Number(temperature.toFixed(2)),
    },
  };
}

/**
 * Analisa o vídeo (fala com timestamps + metadados) e sugere 1–3 cortes
 * com alto potencial de retenção para Reels.
 *
 * @returns {Promise<Array<{ inicio: number, fim: number, legenda: string, motivo?: string }>>}
 */
async function sugerirCortes({
  duracao,
  titulo,
  termo,
  tags,
  transcricao,
  segmentos,
  maxCortes = 3,
  maxSegundos = 90,
  minSegundos = 40,
}) {
  assertDeepseek();

  const total = Math.max(0, Math.round(Number(duracao) || 0));
  if (total < 3) return [];

  const maxClip = Math.min(90, total, Math.max(10, Number(maxSegundos) || 90));
  const minClip = Math.min(maxClip, total, Math.max(3, Number(minSegundos) || 40));
  const preferredMin = Math.min(maxClip, total, Math.max(minClip, 45));
  const preferredMax = Math.min(maxClip, total, 75);
  const n = Math.min(3, Math.max(1, Number(maxCortes) || 3));

  const speechSegments = (Array.isArray(segmentos) ? segmentos : [])
    .map((segment) => ({
      start: Math.max(0, Number(segment.start)),
      end: Math.min(total, Number(segment.end)),
      text: String(segment.text || '').trim(),
    }))
    .filter((segment) => (
      segment.text &&
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start
    ))
    .sort((a, b) => a.start - b.start);

  let timeline = '';
  if (speechSegments.length) {
    timeline = speechSegments
      .slice(0, 500)
      .map((segment) => `[${segment.start.toFixed(1)}-${segment.end.toFixed(1)}] ${segment.text}`)
      .join('\n')
      .slice(0, 30000);
  } else if (transcricao) {
    timeline = String(transcricao).slice(0, 20000);
  }

  const system = `Você é um editor-chefe de vídeos curtos para Reels, Shorts e TikTok.
Escolha somente os melhores momentos que funcionem sozinhos, sem depender do trecho anterior ou seguinte.
Cada corte precisa começar no início natural de uma ideia, apresentar contexto suficiente e terminar depois da conclusão. Nunca comece com pronome ou resposta sem contexto, nem termine no meio de frase, raciocínio ou promessa.
Priorize, nesta ordem: gancho claro, ideia completa, clímax/frase memorável e potencial de retenção. Qualidade vale mais que quantidade: retorne menos cortes se não houver momentos distintos e autossuficientes.
Responda APENAS com JSON válido (sem markdown), ordenado do melhor para o menos forte:
{"cortes":[{"inicio":0,"fim":55,"legenda":"resumo curto do trecho","motivo":"gancho e por que o trecho é completo"}]}`;

  const user = [
    `Duração total do vídeo: ${total}s`,
    `Título: ${titulo || '—'}`,
    `Termo/nicho: ${termo || '—'}`,
    `Tags: ${Array.isArray(tags) ? tags.join(', ') : tags || '—'}`,
    `Retorne no máximo ${n} cortes realmente fortes; não force ${n} opções.`,
    `Duração permitida: ${minClip}–${maxClip}s. Faixa preferida: ${preferredMin}–${preferredMax}s.`,
    `Use cortes abaixo de ${preferredMin}s somente quando o vídeo inteiro for mais curto.`,
    `inicio e fim em segundos, 0 <= inicio < fim <= ${total}.`,
    `Use os timestamps para iniciar antes da contextualização e terminar após a conclusão da ideia.`,
    `Não divida um mesmo raciocínio em vários cortes e evite sobreposição ou conteúdo repetido.`,
    `Descarte trechos que sejam apenas introdução, transição, pergunta sem resposta ou conclusão sem contexto.`,
    `No motivo, explique o gancho e confirme que o trecho tem começo, desenvolvimento e fechamento.`,
    `Se não houver fala útil, selecione pelo ritmo do vídeo, ainda respeitando duração e começo/fim naturais.`,
    '',
    'Fala / timeline:',
    timeline || '(sem transcrição — use título e duração)',
  ].join('\n');

  const raw = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.25, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('DeepSeek retornou JSON inválido na análise de cortes');
    err.status = 502;
    throw err;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.cortes)
      ? parsed.cortes
      : [];

  function speechStartAt(time) {
    const containing = speechSegments.find((segment) => segment.start <= time && segment.end > time);
    if (containing) return containing.start;
    const next = speechSegments.find((segment) => segment.start >= time);
    return next ? next.start : time;
  }

  function speechEndAt(time) {
    const containing = speechSegments.find((segment) => segment.start < time && segment.end >= time);
    if (containing) return containing.end;
    const next = speechSegments.find((segment) => segment.end >= time);
    return next ? next.end : time;
  }

  function findSpeechWindow(center, rawStart, rawEnd, targetDuration) {
    let best = null;
    for (const startSegment of speechSegments) {
      const start = Math.max(0, Math.floor(startSegment.start));
      if (start > center) break;

      for (const endSegment of speechSegments) {
        const end = Math.min(total, Math.ceil(endSegment.end));
        if (end < center) continue;
        const duration = end - start;
        if (duration < minClip || duration > maxClip) continue;

        const covered = Math.max(0, Math.min(end, rawEnd) - Math.max(start, rawStart));
        const coverage = covered / Math.max(1, rawEnd - rawStart);
        const score =
          Math.abs(duration - targetDuration) +
          Math.abs((start + end) / 2 - center) * 0.25 +
          (1 - coverage) * 20;
        if (!best || score < best.score) best = { inicio: start, fim: end, score };
      }
    }
    return best;
  }

  function normalizeRange(item) {
    const requestedStart = Number(item.inicio);
    const requestedEnd = Number(item.fim);
    if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd <= requestedStart) {
      return null;
    }

    const rawStart = Math.max(0, Math.min(requestedStart, total));
    const rawEnd = Math.max(rawStart, Math.min(requestedEnd, total));
    const requestedDuration = rawEnd - rawStart;
    const targetDuration = Math.min(maxClip, Math.max(preferredMin, requestedDuration));
    const center = (rawStart + rawEnd) / 2;

    // Dá um pouco mais de espaço depois do momento central para preservar a conclusão.
    let start = Math.max(0, center - targetDuration * 0.45);
    let end = Math.min(total, start + targetDuration);
    start = Math.max(0, end - targetDuration);

    if (speechSegments.length) {
      start = Math.max(0, speechStartAt(start));
      end = Math.min(total, speechEndAt(end));
    }

    start = Math.max(0, Math.floor(start));
    end = Math.min(total, Math.ceil(end));

    // Se expandir até os limites das frases passar de 90s, procura outra janela
    // formada exclusivamente por começo/fim de segmentos completos.
    if (speechSegments.length && (end - start < minClip || end - start > maxClip)) {
      const speechWindow = findSpeechWindow(center, rawStart, rawEnd, targetDuration);
      if (speechWindow) {
        start = speechWindow.inicio;
        end = speechWindow.fim;
      }
    }

    if (end - start > maxClip) {
      start = Math.max(0, Math.round(center - maxClip * 0.45));
      end = Math.min(total, start + maxClip);
      start = Math.max(0, end - maxClip);
    }

    if (end - start < minClip) {
      const missing = minClip - (end - start);
      const before = Math.min(start, Math.ceil(missing * 0.45));
      start -= before;
      end = Math.min(total, end + missing - before);
      start = Math.max(0, end - minClip);
    }

    start = Math.round(start);
    end = Math.round(end);
    if (end <= start || end - start < minClip || end - start > maxClip) return null;
    return { inicio: start, fim: end };
  }

  function overlapRatio(a, b) {
    const overlap = Math.max(0, Math.min(a.fim, b.fim) - Math.max(a.inicio, b.inicio));
    return overlap / Math.min(a.fim - a.inicio, b.fim - b.inicio);
  }

  function normalizeDescription(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const cortes = [];
  const descriptions = [];
  for (const item of list) {
    const range = normalizeRange(item);
    if (!range) continue;
    // Expansões para dar contexto não podem transformar sugestões diferentes em duplicatas.
    if (cortes.some((existing) => overlapRatio(existing, range) > 0.65)) continue;

    const legenda = String(item.legenda || item.caption || '').trim().slice(0, 500);
    const motivo = String(item.motivo || '').trim().slice(0, 280);
    const description = normalizeDescription(legenda || motivo);
    if (
      description.length >= 20 &&
      descriptions.some((existing) => existing === description)
    ) continue;

    cortes.push({ ...range, legenda, motivo });
    descriptions.push(description);
    if (cortes.length >= n) break;
  }

  if (!cortes.length) {
    const fim = Math.min(total, Math.max(preferredMin, Math.min(maxClip, 60)));
    if (fim >= minClip) {
      cortes.push({
        inicio: 0,
        fim,
        legenda: titulo || 'Confira este trecho',
        motivo: total <= preferredMin
          ? 'Vídeo curto mantido completo para preservar o contexto'
          : 'Trecho inicial ampliado para manter contexto e conclusão',
      });
    }
  }

  return cortes;
}

/**
 * Resumo curto para alerta da Biblioteca de fontes.
 */
async function resumirAlertaBiblioteca({ plataforma, nomeFonte, titulo, url, snippet }) {
  assertDeepseek();
  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content:
          'Você resume conteúdos novos de perfis/canais monitorados. Responda APENAS JSON: {"titulo":"...","resumo":"..."}. Título ≤ 90 chars. Resumo em 1–2 frases em português, factual, sem inventar.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          plataforma,
          fonte: nomeFonte,
          titulo: titulo || null,
          url: url || null,
          snippet: snippet || null,
        }),
      },
    ],
    { temperature: 0.4, json: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      titulo: String(titulo || 'Novo conteúdo').slice(0, 90),
      resumo: String(snippet || titulo || 'Novo conteúdo detectado.').slice(0, 280),
    };
  }
  return {
    titulo: String(parsed.titulo || titulo || 'Novo conteúdo').trim().slice(0, 120),
    resumo: String(parsed.resumo || snippet || '').trim().slice(0, 400),
  };
}

const TITULO_TOMES = {
  natural: 'Natural e jornalístico: claro, fluido, sem exagero.',
  polemico: 'Mais polêmico e provocativo: tensão e contraste, sem fake news nem ofensa gratuita.',
  direto: 'Direto e seco: sujeito + verbo + fato, manchete de portal.',
  curiosidade: 'Curiosidade: abre lacuna ou pergunta implícita que faz a pessoa querer ler.',
  emocional: 'Emocional e humano: ângulo de sentimento/fé, sem melodramático falso.',
  factual: 'Factual e sóbrio: máximo de precisão, mínimo de adjetivo.',
};

/**
 * Sugere um novo título (manchete) para matéria de Página Facebook.
 */
async function sugerirTituloMateria({
  tituloAtual,
  materia,
  fonteTitulo,
  tom = 'natural',
  evitar = [],
}) {
  assertDeepseek();
  const tomKey = TITULO_TOMES[tom] ? tom : 'natural';
  const tomDesc = TITULO_TOMES[tomKey];
  const evitarList = (Array.isArray(evitar) ? evitar : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content: `Você é editor de manchetes para Páginas do Facebook (gospel/notícias).
Regras:
- Responda APENAS JSON: {"titulo":"..."}.
- Uma manchete em português do Brasil, 70–110 caracteres (máx 120).
- NÃO invente fatos que não estejam no texto.
- NÃO use clickbait mentiroso, Caps Lock excessivo nem pontos de exclamação em série.
- Tom pedido: ${tomDesc}
- Diferente do título atual e dos títulos a evitar.`,
      },
      {
        role: 'user',
        content: [
          `Tom: ${tomKey}`,
          tituloAtual ? `Título atual: ${tituloAtual}` : null,
          evitarList.length ? `Evitar (já sugeridos):\n- ${evitarList.join('\n- ')}` : null,
          fonteTitulo ? `Fonte original: ${fonteTitulo}` : null,
          materia ? `Texto da matéria:\n${String(materia).slice(0, 2500)}` : null,
          'Gere UMA manchete nova nesse tom.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    { temperature: tomKey === 'polemico' ? 0.9 : 0.82, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  let titulo = String(parsed.titulo || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!titulo || titulo.toLowerCase() === String(tituloAtual || '').trim().toLowerCase()) {
    const err = new Error('A IA não gerou um título diferente. Tente outro tom ou de novo.');
    err.status = 502;
    throw err;
  }
  return { titulo, tom: tomKey };
}

/**
 * Gera consultas de busca de imagem alinhadas à matéria (prioriza pessoa/fato específico).
 */
async function sugerirConsultasImagem({ titulo, materia, fonteTitulo }) {
  assertDeepseek();
  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content: `Você monta buscas de imagem no Google Images para capa de matéria no Facebook.
Responda APENAS JSON:
{"pessoa":"nome próprio se houver ou null","consultas":["...","...","..."],"motivo":"frase curta"}
Regras:
- Se a matéria fala de pessoa pública/jogador/pastor/político, a 1ª consulta DEVE incluir o nome completo + contexto (ex.: "Julián Álvarez seleção argentina").
- NÃO use termos genéricos tipo "igreja", "futebol", "homem" quando houver pessoa nomeada.
- 3 consultas em português ou nome próprio + inglês se for celebridade internacional.
- Consultas curtas (3–7 palavras), boas para Google Images.
- Sem hashtag.`,
      },
      {
        role: 'user',
        content: [
          titulo ? `Título: ${titulo}` : null,
          fonteTitulo ? `Fonte: ${fonteTitulo}` : null,
          materia ? `Matéria:\n${String(materia).slice(0, 2200)}` : null,
          'Gere as consultas de imagem.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    { temperature: 0.4, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const consultas = (Array.isArray(parsed.consultas) ? parsed.consultas : [])
    .map((c) => String(c || '').replace(/\s+/g, ' ').trim())
    .filter((c) => c.length >= 3)
    .slice(0, 4);

  if (!consultas.length && titulo) {
    consultas.push(String(titulo).split(/\s+/).slice(0, 6).join(' '));
  }

  return {
    pessoa: parsed.pessoa ? String(parsed.pessoa).trim() : null,
    consultas,
    motivo: parsed.motivo ? String(parsed.motivo).trim().slice(0, 160) : null,
  };
}

module.exports = {
  gerarMateriaVideo,
  gerarMateriaImagem,
  gerarMateriaNoticiaFacebook,
  sugerirCortes,
  resumirAlertaBiblioteca,
  sugerirTituloMateria,
  sugerirConsultasImagem,
  TITULO_TOMES,
  assertDeepseek,
  MAX_MATERIA_CHARS,
};
