const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const servicePath = require.resolve('../src/services/materiaChatService');
const controllerPath = require.resolve('../src/controllers/materiaChatController');

function carregarController(responder) {
  delete require.cache[controllerPath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { responder },
  };
  return require(controllerPath);
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.writableEnded = false;
    this.destroyed = false;
    this.output = '';
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  flushHeaders() {}

  write(chunk) {
    this.output += String(chunk);
    return true;
  }

  end(chunk = '') {
    this.output += String(chunk);
    this.writableEnded = true;
    return this;
  }
}

function fakeRequest() {
  const req = new EventEmitter();
  req.body = { texto: 'Escreva uma materia' };
  req.params = { id: 'nova' };
  req.session = { userId: 2 };
  return req;
}

test('mantem NDJSON ativo quando o corpo do POST emite close normalmente', async () => {
  const req = fakeRequest();
  const res = new FakeResponse();
  const controller = carregarController(async ({ onEvent }) => {
    req.emit('close');
    onEvent({ tipo: 'delta', texto: 'OK' });
  });

  await controller.enviar(req, res, () => {});

  assert.equal(res.writableEnded, true);
  assert.match(res.output, /"tipo":"delta"/);
  assert.match(res.output, /"texto":"OK"/);
});

test('para de escrever quando a requisicao e realmente abortada', async () => {
  const req = fakeRequest();
  const res = new FakeResponse();
  const controller = carregarController(async ({ onEvent }) => {
    req.emit('aborted');
    onEvent({ tipo: 'delta', texto: 'NAO DEVE SAIR' });
  });

  await controller.enviar(req, res, () => {});

  assert.equal(res.writableEnded, true);
  assert.doesNotMatch(res.output, /NAO DEVE SAIR/);
});

test('encaminha o modo Claude livre sem confundir com o modo editorial', async () => {
  const req = fakeRequest();
  req.body.tipoConversa = 'livre';
  const res = new FakeResponse();
  let tipoRecebido = null;
  const controller = carregarController(async ({ tipoConversa }) => {
    tipoRecebido = tipoConversa;
  });

  await controller.enviar(req, res, () => {});

  assert.equal(tipoRecebido, 'livre');
  assert.equal(res.writableEnded, true);
});
