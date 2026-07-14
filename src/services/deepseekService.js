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
  // Facebook: texto puro — remove HTML residual se o modelo escapar
  materia = materia.replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const termosImagem = Array.isArray(parsed.termos_imagem)
    ? parsed.termos_imagem.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
    : [];

  if (!materia) {
    const err = new Error('DeepSeek não gerou a matéria');
    err.status = 502;
    throw err;
  }

  if (hashtags.length && !materia.includes('#')) {
    materia = `${materia.trim()}\n\n${hashtags.map((h) => `#${h}`).join(' ')}`;
  }
  if (materia.length > MAX_MATERIA_CHARS) {
    materia = `${materia.slice(0, MAX_MATERIA_CHARS - 1).trim()}…`;
  }
  return { titulo, materia, hashtags, termos_imagem: termosImagem };
}

const SYSTEM_PROMPT_VIDEO = `Você é um redator de Páginas do Facebook. Escreva matérias/legendas ORIGINAIS em português brasileiro.

Regras obrigatórias (Facebook / monetização / anti-plágio):
- NUNCA copie a transcrição ou o texto-fonte palavra por palavra. Reescreva com suas próprias palavras.
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

async function gerarMateriaVideo({ transcricao, titulo, tema, idioma }) {
  if (!transcricao || !String(transcricao).trim()) {
    const err = new Error('Transcrição vazia — extraia a fala do clipe antes');
    err.status = 422;
    throw err;
  }

  const userContent = [
    'Crie uma matéria/legenda ORIGINAL para um Reel no Facebook com base na fala do vídeo.',
    tema ? `Ângulo / tipo de matéria pedido pelo usuário: ${tema}` : null,
    titulo ? `Título/contexto do vídeo de origem: ${titulo}` : null,
    idioma ? `Idioma detectado da fala: ${idioma}` : null,
    'Transcrição da fala (use só como referência, NÃO copie):',
    '---',
    String(transcricao).slice(0, 12000),
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  return chatJson(userContent, sortearTemperatura(false));
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

function systemPromptNoticia(faixa, investigativa) {
  return `Você é redator de Páginas do Facebook. Escreva matérias ORIGINAIS em português brasileiro.

${blocoRegrasFacebook(faixa)}

Formato Facebook (obrigatório):
- Campo "materia" = texto puro da legenda/matéria (SEM HTML, SEM meta description, SEM keywords SEO).
- Campo "hashtags" = 3 a 6 termos sem #.
- Campo "termos_imagem" = 2 a 4 palavras em inglês para buscar foto de stock (ex.: ["church choir","gospel concert"]).
- NÃO invente fatos, nomes, cargos, números ou citações que não estejam nas fontes de apuração.

${investigativa ? 'MODO INVESTIGATIVO: use SOMENTE evidências documentadas; temperatura baixa de criatividade; zero dramatização.' : ''}

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
}) {
  assertDeepseek();

  const faixa = sortearFaixaChars();
  const voz = sortearVozRedator();
  const lead = sortearEstiloLead();
  const estiloTitulo = sortearEstiloTitulo();
  const temperature = sortearTemperatura(investigativa);
  const systemMsg = systemPromptNoticia(faixa, investigativa);

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
    `EXTENSÃO ALVO: ${faixa.min}–${faixa.max} caracteres.`,
    nicho ? `Nicho/palavras-chave: ${nicho}` : null,
    emAlta ? 'Contexto: assunto em alta agora.' : null,
    redeSocial
      ? 'A fonte principal pode ser uma postagem de rede — transforme em matéria de Página, sem copiar o texto literal do post.'
      : null,
    tituloReferencia ? `Título de referência: ${tituloReferencia}` : null,
    resumoReferencia ? `Resumo de referência: ${resumoReferencia}` : null,
    fonte ? `Fonte citada genericamente: ${fonte}` : null,
    dataReferencia ? `Data da fonte: ${dataReferencia}` : null,
    contextoApuracao ? `Contexto de apuração:\n${String(contextoApuracao).slice(0, 6000)}` : null,
    fontesTxt ? `Fontes documentadas:\n${fontesTxt}` : null,
    'Se faltar detalhe factual, generalise com cuidado (ex.: “segundo informações divulgadas”) sem inventar.',
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

module.exports = {
  gerarMateriaVideo,
  gerarMateriaImagem,
  gerarMateriaNoticiaFacebook,
  assertDeepseek,
  MAX_MATERIA_CHARS,
};
