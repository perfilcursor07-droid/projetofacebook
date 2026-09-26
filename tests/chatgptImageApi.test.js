const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarImagem } = require('../src/services/chatgptImageService');

function comApi(fn) {
  return async () => {
    const chaveAntes = process.env.OPENAI_API_KEY;
    const fetchAntes = global.fetch;
    process.env.OPENAI_API_KEY = 'sk-teste';
    try {
      await fn();
    } finally {
      global.fetch = fetchAntes;
      if (chaveAntes === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = chaveAntes;
    }
  };
}

test('com OPENAI_API_KEY a ilustração simbólica sai pela API em 4:5', comApi(async () => {
  let pedido = null;
  global.fetch = async (url, opts) => {
    pedido = { url, corpo: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('jpeg').toString('base64') }] }) };
  };
  const r = await gerarImagem({ modo: 'simbolica' });
  assert.equal(pedido.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(pedido.corpo.size, '1088x1360');
  assert.equal(pedido.corpo.output_format, 'jpeg');
  assert.match(pedido.corpo.prompt, /4:5/);
  assert.equal(r.buffer.toString(), 'jpeg');
  assert.match(r.model, /\(API\)$/);
}));

test('recusa de segurança da API vira erro 422 image_safety_refusal', comApi(async () => {
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }),
  });
  await assert.rejects(gerarImagem({ modo: 'simbolica' }), (err) => {
    assert.equal(err.status, 422);
    assert.equal(err.code, 'image_safety_refusal');
    return true;
  });
}));
