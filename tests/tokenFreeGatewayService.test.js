const http = require('node:http');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

let server;
let gateway;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', browser: 'connected', providers: 1 }));
      return;
    }
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }] }));
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Ola ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          usage: { total_tokens: 12 },
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.AI_PROVIDER = 'token-free';
  process.env.TOKEN_FREE_GATEWAY_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.TOKEN_FREE_GATEWAY_TAREFAS = 'conversa';
  process.env.TOKEN_FREE_GATEWAY_MODEL = 'claude-sonnet-5';

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/services/tokenFreeGatewayService')];
  gateway = require('../src/services/tokenFreeGatewayService');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('normaliza URL e reforca JSON no prompt', () => {
  assert.equal(
    gateway.normalizarBaseUrl('http://localhost:3456'),
    'http://localhost:3456/v1'
  );
  const mensagens = gateway.prepararMensagens(
    [{ role: 'user', content: 'Retorne um objeto' }],
    true
  );
  assert.equal(mensagens[0].role, 'system');
  assert.match(mensagens[0].content, /JSON valido/);
});

test('le resposta OpenAI-compatible e remove cerca de JSON', async () => {
  const resposta = await gateway.chatCompletion(
    [{ role: 'user', content: 'teste' }],
    { json: true, tarefa: 'conversa' }
  );
  assert.equal(resposta, '{"ok":true}');
});

test('entrega streaming SSE ao chat', async () => {
  const deltas = [];
  const resposta = await gateway.chatCompletionStream(
    [{ role: 'user', content: 'teste' }],
    { tarefa: 'conversa', onDelta: (delta) => deltas.push(delta) }
  );
  assert.equal(resposta, 'Ola mundo');
  assert.deepEqual(deltas, ['Ola ', 'mundo']);
});

test('consulta saude e modelos', async () => {
  const saude = await gateway.verificarSaude();
  const modelos = await gateway.listarModelos();
  assert.equal(saude.status, 'ok');
  assert.equal(modelos[0].id, 'claude-sonnet-5');
});
