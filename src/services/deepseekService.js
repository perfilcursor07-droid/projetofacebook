const axios = require('axios');
const { env } = require('../config/env');
const {
  MAX_MATERIA_CHARS,
  sortearFaixaChars,
  classificarVolumeFonte,
  blocoRegraTamanhoAdaptativo,
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
  blocoEstiloNewsGospel,
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
  // Facebook: texto puro — remove HTML/markdown residual, mas PRESERVA parágrafos
  materia = materia
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
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

  const { anexarHashtagsAoFinal, formatHashtagsLine } = require('./editorialGuidelinesFb');
  const tagsLine = formatHashtagsLine(hashtags);
  const reserve = tagsLine ? tagsLine.length + 2 : 0;
  if (materia.length > MAX_MATERIA_CHARS - reserve) {
    materia = `${materia.slice(0, Math.max(40, MAX_MATERIA_CHARS - reserve - 1)).trim()}…`;
  }
  // Hashtags sempre no final do texto gerado (visível na edição e no copy)
  materia = anexarHashtagsAoFinal(materia, hashtags);
  return { titulo, materia, hashtags, termos_imagem: termosImagem };
}

const SYSTEM_PROMPT_VIDEO = `Você é redator de Página gospel no Facebook (estilo News Gospel). Escreva matérias/legendas ORIGINAIS em português brasileiro.

${blocoEstiloNewsGospel()}

Regras obrigatórias:
- NÃO cole a transcrição/legenda inteira nem parafraseie frase a frase.
- DEIXE 1 a 3 FALAS LITERAIS curtas entre aspas ("…") quando houver na fonte — exatamente como foram ditas.
- Não invente fatos, números, nomes ou falas que não estejam na fonte.
- Sem clickbait, sem pedir like/compartilhar/"não perca"/"assista até o final".
- Inclua 3 a 5 hashtags relevantes no campo hashtags (sem # no valor).
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
    'Crie uma matéria ORIGINAL estilo News Gospel para um Reel no Facebook.',
    'A base abaixo é a FALA do vídeo (transcrição) OU a legenda original do post — use SOMENTE esse conteúdo. Não invente fatos fora dele.',
    'PROIBIDO colar a transcrição/legenda inteira. Reescreva como redator de portal gospel.',
    'ESTRUTURA OBRIGATÓRIA:',
    '1) Lead: apresente quem fala / o tema com contexto (nome, o que é conhecido, o assunto).',
    '2) Desenvolvimento: narre o conteúdo com suas palavras + 1 a 3 falas literais curtas entre aspas ("…").',
    '3) Fechamento de fé: oração, gratidão, esperança ou reflexão espiritual ligada ao fato — sem pedir like/compartilhar.',
    'Exemplo de aspas: Ele afirma: "Eu entendi que sem Deus eu não era nada".',
    'O campo "titulo" = MANCHETE CURTA (máx. 90 caracteres). NÃO cole a legenda/transcrição no título.',
    'Separe parágrafos com linha em branco. Alvo: 1700–2100 caracteres (máximo útil Face/Insta).',
    'Se a base for longa, condense preservando os dados principais; se for curta, complete com contexto real até o máximo.',
    tema ? `Ângulo / tipo de matéria pedido pelo usuário: ${tema}` : null,
    titulo ? `Título/contexto do vídeo de origem: ${String(titulo).slice(0, 120)}` : null,
    idioma ? `Idioma detectado da fala: ${idioma}` : null,
    'Base (transcrição ou legenda — use trechos curtos entre aspas; o restante reescreva):',
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
      'Reescreva no estilo News Gospel: lead + desenvolvimento + fechamento de fé.',
      'Mantenha apenas 1–3 frases curtas entre aspas ("…") tiradas da fala — o resto NÃO pode ser cópia.',
      'Feche com oração, gratidão ou reflexão espiritual — sem pedir like/compartilhar.',
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
    'Crie uma matéria ORIGINAL estilo News Gospel para um post de FOTO no Facebook.',
    `Tipo/tema pedido pelo usuário: ${tema}`,
    termo ? `Termo de busca / contexto: ${termo}` : null,
    descricaoImagem ? `Descrição/alt da imagem: ${descricaoImagem}` : null,
    autor ? `Autor da foto (crédito se fizer sentido no fechamento): ${autor}` : null,
    'ESTRUTURA: lead com o fato/tema → desenvolvimento com detalhes → fechamento de fé (oração, gratidão ou reflexão).',
    'Tom de portal gospel: caloroso, claro, sem clickbait e sem pedir like/compartilhar.',
    'Parágrafos curtos com linha em branco. Alvo: 1700–2100 caracteres (máximo útil Face/Insta).',
    'Se fizer sentido, no último parágrafo pode citar crédito curto (ex.: Reprodução) — sem inventar @ de quem não foi informado.',
  ]
    .filter(Boolean)
    .join('\n');

  return chatJson(userContent, sortearTemperatura(false));
}

function systemPromptNoticia(faixa, investigativa, furoReportagem = false, volumeFonte = 'media') {
  return `Você é redator de Página gospel no Facebook e Instagram (estilo News Gospel). Escreva matérias ORIGINAIS em português brasileiro.

${blocoRegrasFacebook(faixa, volumeFonte)}

Formato Facebook/Instagram (obrigatório):
- Campo "materia" = texto puro da legenda/matéria (SEM HTML, SEM markdown, SEM meta description).
- Campo "hashtags" = 3 a 5 termos sem #.
- Campo "termos_imagem" = 2 a 4 consultas específicas para encontrar uma foto realmente relacionada.
  - Se houver pessoas, use primeiro os nomes completos e exatos em português (ex.: ["Ricky Tavares Get Church","Ricky Tavares"]).
  - Não troque pessoas citadas por conceitos genéricos como "church", "politics" ou "gospel".
  - Use termos de stock em inglês somente quando a pauta não citar pessoa, organização ou lugar específico.
- NÃO invente fatos, nomes, cargos, números ou citações que não estejam nas fontes de apuração.

${investigativa ? 'MODO INVESTIGATIVO: use SOMENTE evidências documentadas; temperatura baixa de criatividade; zero dramatização falsa.' : ''}
${furoReportagem ? `MODO FURO / MINIMATÉRIA (obrigatório):
- A fonte é uma notícia/post/vídeo já publicado.
- Se a fonte for LONGA: condense no tamanho máximo Face/Insta, preservando os dados principais.
- Se a fonte for CURTA: amplie com contexto real da apuração até o tamanho máximo — sem inventar.
- Encontre o FURO: o ângulo mais jornalístico e específico.
- Estrutura: lead (quem + fato) + desenvolvimento com aspas + fechamento de fé.
- OBRIGATÓRIO: preserve 1 a 3 falas literais curtas entre aspas ("…") quando houver declaração na apuração.
- Título próprio — nunca copie a manchete da fonte.
- Não inclua bloco "Fontes:" — o sistema anexa créditos da origem e da imagem.` : ''}

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

  const fontesTxt = Array.isArray(fontesApuracao) && fontesApuracao.length
    ? fontesApuracao
        .slice(0, 5)
        .map((f, i) => {
          return [
            `Fonte ${i + 1}: ${f.veiculo || 'Veículo'}`,
            f.url ? `URL: ${f.url}` : null,
            f.titulo ? `Título: ${f.titulo}` : null,
            f.resumo ? `Resumo: ${f.resumo}` : null,
            f.trecho ? `Trecho documentado: ${String(f.trecho).slice(0, 2500)}` : null,
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

  const volumeFonte = classificarVolumeFonte(materialApuracao);
  const systemMsg = systemPromptNoticia(faixa, investigativa, furoReportagem, volumeFonte);

  const userContent = [
    'Crie uma MINIMATÉRIA ORIGINAL estilo News Gospel para Facebook/Instagram (foto + legenda).',
    `VOZ DO REDATOR (obrigatório): ${voz}`,
    `ESTILO DO LEAD: ${lead}`,
    `ESTILO DO TÍTULO: ${estiloTitulo}`,
    `VOLUME DA FONTE: ${volumeFonte.toUpperCase()}.`,
    blocoRegraTamanhoAdaptativo(faixa, volumeFonte),
    `EXTENSÃO OBRIGATÓRIA DO CORPO: ${faixa.min}–${faixa.max} caracteres (sem hashtags). Meta: perto de ${faixa.max}.`,
    'FORMATAÇÃO: 5 a 8 parágrafos curtos separados por linha em branco.',
    'ESTRUTURA: (1) lead com quem + fato; (2) desenvolvimento com dados principais + aspas reais; (3) fechamento de fé — sem pedir like/compartilhar.',
    nicho ? `Nicho/palavras-chave: ${nicho}` : null,
    emAlta ? 'Contexto: assunto em alta agora.' : null,
    redeSocial
      ? 'A fonte é post/vídeo de rede social. Transforme em minimatéria gospel: contextualize com suas palavras e DEIXE 1–3 falas literais curtas entre aspas ("…") da apuração.'
      : null,
    furoReportagem
      ? 'PRIORIDADE: ângulo de furo + reescrita total. Fonte longa = condensar; fonte curta = completar com contexto real.'
      : null,
    tituloReferencia ? `Título de referência: ${tituloReferencia}` : null,
    resumoReferencia ? `Resumo de referência: ${resumoReferencia}` : null,
    fonte ? `Veículo/origem: ${fonte}` : null,
    dataReferencia ? `Data da fonte: ${dataReferencia}` : null,
    contextoApuracao ? `Contexto de apuração:\n${String(contextoApuracao).slice(0, 8000)}` : null,
    fontesTxt ? `Fontes documentadas:\n${fontesTxt}` : null,
    'Se faltar detalhe factual, generalise com cuidado (ex.: “segundo informações divulgadas”) sem inventar.',
    'Quando houver fala documentada, use aspas em pelo menos uma frase literal no corpo.',
    'NÃO inclua créditos/Fontes no campo materia — o sistema anexa automaticamente.',
    'MODELO DE TOM (inspire-se, não copie): "O ator X tem se dedicado ao chamado…", "Em meio à devastação… uma notícia trouxe esperança…", "Que Deus console… Seguimos em oração…".',
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
            content: `Matéria ABAIXO DO MÁXIMO Face/Insta (${qualidade.chars} caracteres; alvo ${faixa.min}–${faixa.max}).
Amplie até perto de ${faixa.max} caracteres SEM inventar fatos nem muletas de IA.
Use só contexto real da apuração (quem é, lugar, carreira/ministério, desdobramento, fechamento de fé).
Mantenha o mesmo ângulo e as falas literais.

APURAÇÃO (para embasar a expansão):
${String(materialApuracao).slice(0, 5000)}

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
            content: `Matéria ACIMA DO MÁXIMO Face/Insta (${qualidade.chars} caracteres).
CONDENSE para ${faixa.min}–${faixa.max} (máx ${MAX_MATERIA_CHARS}).
Preserve os dados principais (nomes, números, datas, lugares, decisões e aspas). Remova só repetição/enrolação.

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
{"cortes":[{"inicio":0,"fim":55,"titulo":"manchete curta para capa do Reel (máx 80 chars)","legenda":"resumo curto do trecho","motivo":"gancho e por que o trecho é completo"}]}`;

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
    `Campo "titulo" = manchete curta e impactante para a capa do Reel (máx. 80 caracteres), sem colar a transcrição.`,
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

  return normalizeCortesList(list, {
    total,
    minClip,
    maxClip,
    preferredMin,
    speechSegments,
    titulo,
    n,
  });
}

function normalizeCortesList(list, {
  total,
  minClip,
  maxClip,
  preferredMin,
  speechSegments = [],
  titulo = null,
  n = 3,
}) {
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
    const tituloSugestao = String(item.titulo || item.title || legenda || titulo || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
    const description = normalizeDescription(legenda || motivo || tituloSugestao);
    if (
      description.length >= 20 &&
      descriptions.some((existing) => existing === description)
    ) continue;

    cortes.push({
      ...range,
      titulo: tituloSugestao || `Trecho ${range.inicio}s–${range.fim}s`,
      legenda,
      motivo,
    });
    descriptions.push(description);
    if (cortes.length >= n) break;
  }

  if (!cortes.length) {
    const fim = Math.min(total, Math.max(preferredMin, Math.min(maxClip, 60)));
    if (fim >= minClip) {
      cortes.push({
        inicio: 0,
        fim,
        titulo: String(titulo || 'Confira este trecho').slice(0, 90),
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
 * Mapeia um pedido em texto livre do usuário para cortes no vídeo (usando a transcrição).
 */
async function mapearPedidoParaCortes({
  duracao,
  titulo,
  pedido,
  transcricao,
  segmentos,
  maxCortes = 3,
  maxSegundos = 90,
  minSegundos = 40,
}) {
  assertDeepseek();
  const pedidoTxt = String(pedido || '').trim();
  if (!pedidoTxt) {
    const err = new Error('Descreva quais Reels você quer criar');
    err.status = 400;
    throw err;
  }

  const total = Math.max(0, Math.round(Number(duracao) || 0));
  if (total < 3) return [];

  const maxClip = Math.min(90, total, Math.max(10, Number(maxSegundos) || 90));
  const minClip = Math.min(maxClip, total, Math.max(3, Number(minSegundos) || 40));
  const preferredMin = Math.min(maxClip, total, Math.max(minClip, 45));

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

  const n = Math.min(3, Math.max(1, Number(maxCortes) || 3));
  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content: `Você é editor de Reels. O usuário descreveu quais trechos quer.
Com base na timeline/transcrição, escolha os trechos que atendem o pedido.
Cada corte deve ser autossuficiente (começo, desenvolvimento, fim), ${minClip}–${maxClip}s.
Responda APENAS JSON:
{"cortes":[{"inicio":0,"fim":55,"titulo":"manchete curta (máx 80)","legenda":"resumo","motivo":"por que atende o pedido"}]}`,
      },
      {
        role: 'user',
        content: [
          `Pedido do usuário: ${pedidoTxt}`,
          `Duração total: ${total}s`,
          `Título do vídeo: ${titulo || '—'}`,
          `Máximo ${n} cortes. Prefira qualidade.`,
          `0 <= inicio < fim <= ${total}.`,
          '',
          'Timeline / fala:',
          timeline || '(sem transcrição — estime pelo título e pedido)',
        ].join('\n'),
      },
    ],
    { temperature: 0.3, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('A IA não entendeu o pedido de Reels. Tente descrever de outro jeito.');
    err.status = 502;
    throw err;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.cortes)
      ? parsed.cortes
      : [];

  return normalizeCortesList(list, {
    total,
    minClip,
    maxClip,
    preferredMin,
    speechSegments,
    titulo: pedidoTxt.slice(0, 90),
    n,
  });
}

/**
 * Ranqueia posts da Biblioteca pelo potencial de viralizar no Facebook.
 * Respeita diretrizes: título chamativo ok, sem clickbait enganoso / conteúdo proibido.
 * @param {Array<{id:number,titulo?:string,resumo?:string,fonte?:string,plataforma?:string}>} candidatos
 * @param {number} topN
 * @returns {Promise<Array<{id:number,score:number,motivo:string}>>}
 */
async function ranquearPostsViralFacebook(candidatos, topN = 3) {
  assertDeepseek();
  const lista = (Array.isArray(candidatos) ? candidatos : [])
    .filter((c) => c && c.id != null)
    .slice(0, 30)
    .map((c) => ({
      id: Number(c.id),
      titulo: String(c.titulo || '').slice(0, 200),
      resumo: String(c.resumo || '').slice(0, 400),
      fonte: String(c.fonte || c.fonte_nome || '').slice(0, 120),
      plataforma: String(c.plataforma || c.fonte_plataforma || '').slice(0, 40),
    }));

  const n = Math.min(Math.max(Number(topN) || 1, 1), 5);
  if (!lista.length) return [];

  if (lista.length <= n) {
    return lista.map((c, i) => ({
      id: c.id,
      score: 80 - i,
      motivo: 'Poucos candidatos — ordem por recência.',
    }));
  }

  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content: `Você é editor de uma página no Facebook (estilo notícia / engajamento).
Escolha os posts com MAIOR potencial de viralizar no Facebook AGORA.
Critérios: relevância, emoção/curiosidade legítima, clareza do assunto, atualidade, potencial de compartilhamento.
PROIBIDO priorizar: clickbait enganoso, sensacionalismo falso, conteúdo que viole diretrizes do Facebook (ódio, violência gráfica, desinformação deliberada, spam, nudez, etc.).
Título chamativo é bem-vindo se for honesto com o conteúdo.
Responda APENAS JSON: {"ranking":[{"id":123,"score":0-100,"motivo":"frase curta"}]}.
Ordene do melhor para o pior. Inclua no máximo ${n} itens. Use só IDs da lista.`,
      },
      {
        role: 'user',
        content: JSON.stringify({ topN: n, candidatos: lista }),
      },
    ],
    { temperature: 0.35, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const idsValidos = new Set(lista.map((c) => c.id));
  const ranking = Array.isArray(parsed?.ranking) ? parsed.ranking : [];
  const out = [];
  for (const item of ranking) {
    const id = Number(item?.id);
    if (!idsValidos.has(id) || out.some((x) => x.id === id)) continue;
    out.push({
      id,
      score: Math.min(100, Math.max(0, Number(item.score) || 50)),
      motivo: String(item.motivo || '').trim().slice(0, 200),
    });
    if (out.length >= n) break;
  }

  // Fallback: completa com os mais recentes se a IA devolveu pouco
  if (out.length < n) {
    for (const c of lista) {
      if (out.some((x) => x.id === c.id)) continue;
      out.push({ id: c.id, score: 40, motivo: 'Complemento por recência.' });
      if (out.length >= n) break;
    }
  }

  return out;
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

function normalizeTituloCmp(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''`´"″«»“”‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTituloFromAi(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && typeof parsed === 'object') {
    const candidate =
      parsed.titulo ||
      parsed.title ||
      parsed.manchete ||
      parsed.headline ||
      (parsed.data && (parsed.data.titulo || parsed.data.title));
    const titulo = String(candidate || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (titulo) return titulo;
  }

  // Fallback: resposta veio como texto puro
  const plain = text
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (plain && !plain.startsWith('{') && plain.length >= 20) return plain;
  return '';
}

function tituloJaUsado(titulo, tituloAtual, evitarList) {
  const n = normalizeTituloCmp(titulo);
  if (!n) return true;
  if (n === normalizeTituloCmp(tituloAtual)) return true;
  return evitarList.some((t) => normalizeTituloCmp(t) === n);
}

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

  const baseMessages = (attempt) => [
    {
      role: 'system',
      content: `Você é editor de manchetes para Páginas do Facebook (gospel/notícias).
Regras:
- Responda APENAS JSON válido: {"titulo":"sua manchete aqui"}
- Uma manchete em português do Brasil, 70–110 caracteres (máx 120).
- NÃO invente fatos que não estejam no texto.
- NÃO use clickbait mentiroso, Caps Lock excessivo nem pontos de exclamação em série.
- Tom pedido: ${tomDesc}
- OBRIGATÓRIO: a manchete deve ser SUBSTANCIALMENTE diferente do título atual (mude ângulo, sujeito ou formulação).
${attempt > 1 ? '- Tentativa anterior falhou por repetir o título. Varie bastante a estrutura da frase.' : ''}`,
    },
    {
      role: 'user',
      content: [
        `Tom: ${tomKey}`,
        tituloAtual ? `Título atual (NÃO repetir):\n${tituloAtual}` : null,
        evitarList.length ? `Também NÃO use estes:\n- ${evitarList.join('\n- ')}` : null,
        fonteTitulo ? `Fonte original: ${fonteTitulo}` : null,
        materia ? `Texto da matéria:\n${String(materia).slice(0, 2500)}` : null,
        attempt > 1
          ? 'Gere UMA manchete NOVA, com palavras e estrutura bem diferentes.'
          : 'Gere UMA manchete nova nesse tom.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  let ultimoTitulo = '';
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const temp =
      attempt === 1
        ? tomKey === 'polemico'
          ? 0.95
          : 0.88
        : 1.05;
    const raw = await chatCompletion(baseMessages(attempt), {
      temperature: Math.min(temp, 1.3),
      json: true,
    });
    const titulo = parseTituloFromAi(raw);
    ultimoTitulo = titulo;
    if (titulo && !tituloJaUsado(titulo, tituloAtual, evitarList)) {
      return { titulo, tom: tomKey };
    }
  }

  const err = new Error(
    ultimoTitulo
      ? 'A IA repetiu um título parecido. Troque o tom (ex.: Direto ou Curiosidade) e tente de novo.'
      : 'A IA não devolveu um título válido. Tente de novo em alguns segundos.'
  );
  err.status = 502;
  throw err;
}

/**
 * Reescreve a matéria incorporando informações avulsas fornecidas pelo usuário.
 */
async function reescreverMateriaComInfo({
  titulo,
  materia,
  infoExtra,
  hashtags = [],
  fonteTitulo = null,
}) {
  assertDeepseek();
  const extra = String(infoExtra || '').trim();
  if (!extra) {
    const err = new Error('Cole as informações extras para a IA incorporar no texto.');
    err.status = 400;
    throw err;
  }
  if (!String(materia || '').trim()) {
    const err = new Error('Não há matéria para reescrever.');
    err.status = 400;
    throw err;
  }

  const tagsHint = Array.isArray(hashtags) && hashtags.length
    ? hashtags.map((h) => String(h).replace(/^#/, '')).slice(0, 6).join(', ')
    : null;

  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content: `Você é redator de Páginas do Facebook (gospel/notícias).
Reescreva a matéria/legenda incorporando as INFORMAÇÕES EXTRAS do usuário.
Regras:
- Responda APENAS JSON: {"titulo":"...","materia":"...","hashtags":["..."]}
- O título pode melhorar levemente (máx. 110 chars) se as novas infos mudarem o gancho; senão mantenha próximo do atual.
- A matéria deve ficar mais forte e completa: use as infos extras (fatos, nomes, números, contexto) sem inventar o que não estiver no texto atual nem nas extras.
- Português do Brasil, parágrafos curtos separados por linha em branco (\\n\\n).
- Ideal 1700–2100 caracteres no corpo (máximo útil Face/Insta, sem hashtags).
- 3 a 5 hashtags sem # no JSON.
- Sem pedir like, sem clickbait mentiroso, sem Caps Lock excessivo.
- Preserve o bloco "Fontes:" se já existir no texto atual.`,
      },
      {
        role: 'user',
        content: [
          titulo ? `Título atual: ${titulo}` : null,
          fonteTitulo ? `Fonte: ${fonteTitulo}` : null,
          tagsHint ? `Hashtags atuais: ${tagsHint}` : null,
          `Matéria atual:\n${String(materia).slice(0, 4000)}`,
          `INFORMAÇÕES EXTRAS PARA INCORPORAR:\n${extra.slice(0, 3000)}`,
          'Reescreva título + matéria integrando as extras de forma natural.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    { temperature: 0.75, json: true }
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const novoTitulo = String(parsed.titulo || titulo || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  let novaMateria = String(parsed.materia || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!novaMateria) {
    const err = new Error('A IA não devolveu o texto reescrito. Tente de novo.');
    err.status = 502;
    throw err;
  }
  // Garante parágrafos com linha em branco
  novaMateria = novaMateria
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');

  let novasHashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6)
    : [];
  if (!novasHashtags.length && Array.isArray(hashtags)) {
    novasHashtags = hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6);
  }

  return {
    titulo: novoTitulo || String(titulo || '').trim(),
    materia: novaMateria.slice(0, 4000),
    hashtags: novasHashtags,
  };
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

/**
 * Identifica o nome do autor/fotógrafo a partir dos metadados da imagem interna.
 * Se não houver autor claro, retorna null (o sistema usa Reprodução/Internet).
 */
async function identificarAutorImagem({ autor, fonte, titulo, origem } = {}) {
  const { extrairAutorImagemHeuristico } = require('./editorialGuidelinesFb');
  const heuristico = extrairAutorImagemHeuristico({ autor, fonte, titulo });
  if (heuristico) return heuristico;

  const temSinal = [autor, fonte, titulo].some((x) => String(x || '').trim().length >= 3);
  if (!temSinal) return null;

  try {
    assertDeepseek();
    const raw = await chatCompletion(
      [
        {
          role: 'system',
          content: `Você identifica o AUTOR/FOTÓGRAFO de uma imagem a partir dos metadados internos da busca.
Responda APENAS JSON: {"autor":"Nome Completo"} ou {"autor":null}.
Regras:
- Só retorne nome se for claramente pessoa ou crédito fotográfico (ex.: "João Silva", "Agência Brasil", "Ricardo Stuckert").
- Se for só site/rede (G1, Instagram, Facebook, UOL, YouTube, domínio .com) → autor null.
- Se for genérico (Pexels, Unsplash, Stock, Internet) sem nome de pessoa → autor null.
- NÃO invente nomes. Na dúvida, null.`,
        },
        {
          role: 'user',
          content: [
            autor ? `Campo autor: ${String(autor).slice(0, 120)}` : null,
            fonte ? `Campo fonte: ${String(fonte).slice(0, 160)}` : null,
            titulo ? `Título/alt da imagem: ${String(titulo).slice(0, 220)}` : null,
            origem ? `Origem da busca: ${origem}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      { temperature: 0.1, json: true }
    );
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const nome = String(parsed.autor || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!nome || /null|undefined|n\/a|nenhum/i.test(nome)) return null;
    return extrairAutorImagemHeuristico({ autor: nome }) || nome;
  } catch (err) {
    console.warn('identificarAutorImagem:', err.message);
    return null;
  }
}

module.exports = {
  gerarMateriaVideo,
  gerarMateriaImagem,
  gerarMateriaNoticiaFacebook,
  sugerirCortes,
  mapearPedidoParaCortes,
  resumirAlertaBiblioteca,
  ranquearPostsViralFacebook,
  sugerirTituloMateria,
  reescreverMateriaComInfo,
  sugerirConsultasImagem,
  identificarAutorImagem,
  TITULO_TOMES,
  assertDeepseek,
  MAX_MATERIA_CHARS,
};
