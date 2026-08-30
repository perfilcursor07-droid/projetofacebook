const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const axios = require('axios');

const credentialCipher = require('../src/services/credentialCipher');
const aiProviderService = require('../src/services/aiProviderService');

test('cifra credencial antes de persistir e recupera o valor original', () => {
  const original = 'sk-teste-nao-real-123';
  const encrypted = credentialCipher.encrypt(original);
  assert.ok(encrypted.startsWith('v1:'));
  assert.equal(encrypted.includes(original), false);
  assert.equal(credentialCipher.decrypt(encrypted), original);
});

test('limpa cerca de JSON sem alterar JSON puro', () => {
  assert.equal(aiProviderService.stripJsonFence('```json\n{"ok":true}\n```'), '{"ok":true}');
  assert.equal(aiProviderService.stripJsonFence('{"ok":true}'), '{"ok":true}');
});

test('extrai texto da Responses API', () => {
  assert.equal(aiProviderService.extractResponseText({ output_text: 'direto' }), 'direto');
  assert.equal(
    aiProviderService.extractResponseText({
      output: [{ content: [{ type: 'output_text', text: 'parte 1' }, { type: 'output_text', text: ' parte 2' }] }],
    }),
    'parte 1 parte 2'
  );
});

test('descreve os modelos para o indicador do Matéria manual', () => {
  assert.deepEqual(
    aiProviderService.describe({ provider: 'grok', model: 'grok-4.6', origin: 'xai' }),
    {
      provider: 'grok',
      modelo: 'grok-4.6',
      nome: 'Grok 4.6',
      nivel: '',
      origem: 'xai',
      provedorNome: 'Grok',
    }
  );
});

test('usa a Responses API para o ChatGPT sem expor a chave no corpo', async () => {
  const originalPost = axios.post;
  let request = null;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { output_text: 'resposta OpenAI' } };
  };
  try {
    const text = await aiProviderService.complete(
      {
        provider: 'openai',
        label: 'ChatGPT',
        model: 'gpt-teste',
        configured: true,
        apiKey: 'sk-chave-falsa',
      },
      [{ role: 'system', content: 'Seja direto.' }, { role: 'user', content: 'Olá' }]
    );
    assert.equal(text, 'resposta OpenAI');
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.body.model, 'gpt-teste');
    assert.equal(JSON.stringify(request.body).includes('sk-chave-falsa'), false);
    assert.equal(request.options.headers.Authorization, 'Bearer sk-chave-falsa');
  } finally {
    axios.post = originalPost;
  }
});

test('usa os endpoints oficiais compatíveis para DeepSeek e Grok', async () => {
  const originalPost = axios.post;
  const urls = [];
  axios.post = async (url) => {
    urls.push(url);
    return { data: { choices: [{ message: { content: 'ok' } }] } };
  };
  try {
    for (const provider of ['deepseek', 'grok']) {
      await aiProviderService.complete(
        {
          provider,
          label: provider === 'grok' ? 'Grok' : 'DeepSeek',
          model: `${provider}-teste`,
          configured: true,
          apiKey: 'chave-falsa',
        },
        [{ role: 'user', content: 'Olá' }]
      );
    }
    assert.deepEqual(urls, [
      'https://api.deepseek.com/chat/completions',
      'https://api.x.ai/v1/chat/completions',
    ]);
  } finally {
    axios.post = originalPost;
  }
});

test('preserva streaming do provedor selecionado no Matéria manual', async () => {
  const originalPost = axios.post;
  axios.post = async () => ({
    data: Readable.from([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Olá ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  });
  const deltas = [];
  try {
    const text = await aiProviderService.completeStream(
      {
        provider: 'grok',
        label: 'Grok',
        model: 'grok-teste',
        configured: true,
        apiKey: 'chave-falsa',
      },
      [{ role: 'user', content: 'Olá' }],
      { onDelta: (delta) => deltas.push(delta) }
    );
    assert.equal(text, 'Olá mundo');
    assert.deepEqual(deltas, ['Olá ', 'mundo']);
  } finally {
    axios.post = originalPost;
  }
});
