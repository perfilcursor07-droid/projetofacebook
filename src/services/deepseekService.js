const axios = require('axios');
const { env } = require('../config/env');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_MATERIA_CHARS = 3500;

function assertDeepseek() {
  if (!env.deepseekApiKey) {
    const err = new Error('DEEPSEEK_API_KEY não configurada no .env');
    err.status = 500;
    throw err;
  }
}

const SYSTEM_PROMPT = `Você é um redator de Páginas do Facebook. Escreva matérias/legendas ORIGINAIS em português brasileiro.

Regras obrigatórias (Facebook / monetização / anti-plágio):
- NUNCA copie a transcrição ou o texto-fonte palavra por palavra. Reescreva com suas próprias palavras.
- Não invente fatos, números, nomes ou eventos que não estejam na fonte.
- Sem clickbait enganoso, sem pedir likes/compartilhamentos de forma inautêntica.
- Tom de matéria jornalística leve, clara e pública (adequada a Página do Facebook).
- Não inclua links externos desnecessários nem música/copyright de terceiros.
- Inclua 3 a 6 hashtags relevantes no campo hashtags (sem # duplicado no texto).
- A matéria final deve ter no máximo ${MAX_MATERIA_CHARS} caracteres.
- Responda APENAS com JSON válido, sem markdown: {"titulo":"...","materia":"...","hashtags":["..."]}`;

async function chatJson(userContent) {
  assertDeepseek();
  const { data } = await axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${env.deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 90_000,
    }
  );

  const raw = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error('DeepSeek retornou resposta inválida');
    err.status = 502;
    throw err;
  }

  const titulo = String(parsed.titulo || '').trim();
  let materia = String(parsed.materia || '').trim();
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean)
    : [];

  if (!materia) {
    const err = new Error('DeepSeek não gerou a matéria');
    err.status = 502;
    throw err;
  }

  if (hashtags.length) {
    const tagLine = hashtags.map((h) => `#${h}`).join(' ');
    if (!materia.includes('#')) {
      materia = `${materia.trim()}\n\n${tagLine}`;
    }
  }

  if (materia.length > MAX_MATERIA_CHARS) {
    materia = materia.slice(0, MAX_MATERIA_CHARS - 1).trim() + '…';
  }

  return { titulo, materia, hashtags };
}

/**
 * Gera matéria a partir da transcrição de um clipe.
 */
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

  return chatJson(userContent);
}

/**
 * Gera matéria para acompanhar uma imagem no Facebook.
 */
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

  return chatJson(userContent);
}

module.exports = {
  gerarMateriaVideo,
  gerarMateriaImagem,
  assertDeepseek,
  MAX_MATERIA_CHARS,
};
