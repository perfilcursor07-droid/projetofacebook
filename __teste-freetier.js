process.env.GEMINI_API_KEY = 'chave-de-teste';
process.env.ANTHROPIC_API_KEY = 'chave-claude-de-teste';
process.env.AI_PROVIDER = 'claude';
process.env.DEEPSEEK_API_KEY = '';

const axios = require('axios');
const chamadas = [];
axios.post = async (url, body) => {
  chamadas.push({ url, model: body.model });
  return {
    data: {
      choices: [{ message: { content: JSON.stringify({ titulos: ['Titulo vindo do tier gratis'] }) } }],
      usage: { total_tokens: 42 },
    },
  };
};

const d = require('./src/services/deepseekService');

(async () => {
  const r = await d.sugerirTituloMateria({
    tituloAtual: 'Teste',
    materia: 'Corpo da materia para o modelo trabalhar em cima.',
    fonteTitulo: 'Fonte X',
  });
  console.log('--- chamadas HTTP feitas ---');
  chamadas.forEach((c) => console.log(' ->', c.url, '| model =', c.model));
  console.log('--- retorno ---');
  console.log(JSON.stringify(r).slice(0, 300));
})().catch((e) => console.error('ERRO:', e.message));
