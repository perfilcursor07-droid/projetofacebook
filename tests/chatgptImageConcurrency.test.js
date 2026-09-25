const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(process.env.CHATGPT_SERVICE_TEST_PATH || path.join(__dirname, '../src/services/chatgptImageService.js'), 'utf8');
const helpers = source.slice(source.indexOf('const conversasRecentes'), source.indexOf('async function credenciaisChatgpt'));

function runtime(connect, active = true) {
  const context = vm.createContext({
    require: () => ({ chromium: { connectOverCDP: connect } }),
    PLAYWRIGHT_PATH: 'mock',
    websocketCdp: async () => 'ws://mock',
    verificarSessaoChatgpt: async () => ({ estado: active ? 'ativa' : 'expirada' }),
  });
  vm.runInContext(helpers, context);
  return context;
}

test('three requests share one CDP connection and reconnect after disconnect', async () => {
  let connections = 0;
  let disconnected;
  const browser = { on: (_, listener) => { disconnected = listener; } };
  const r = runtime(async () => { connections += 1; return browser; });
  const results = await Promise.all([r.obterBrowser(), r.obterBrowser(), r.obterBrowser()]);
  assert.equal(connections, 1);
  assert.ok(results.every((result) => result === browser));
  disconnected();
  await r.obterBrowser();
  assert.equal(connections, 2);
});

test('failed CDP connection does not poison following requests', async () => {
  let count = 0;
  const r = runtime(async () => {
    if (++count === 1) throw new Error('Timeout');
    return { on() {} };
  });
  await assert.rejects(r.obterBrowser(), { status: 503 });
  await r.obterBrowser();
  assert.equal(count, 2);
});

test('preparation is serialized and release is idempotent', async () => {
  const r = runtime();
  const first = await r.reservarPreparacao();
  let secondStarted = false;
  const second = r.reservarPreparacao().then((release) => { secondStarted = true; return release; });
  let thirdStarted = false;
  const third = r.reservarPreparacao().then((release) => { thirdStarted = true; return release; });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  first();
  const releaseSecond = await second;
  first();
  await Promise.resolve();
  assert.equal(thirdStarted, false);
  releaseSecond();
  (await third)();
});

function pageMock(failures) {
  let waits = 0;
  const page = {
    reloads: 0,
    isClosed: () => false,
    url: () => 'https://chatgpt.com/',
    reload: async () => { page.reloads += 1; },
    locator: () => ({ first: () => ({
      waitFor: async () => {
        if (++waits <= failures) throw new Error('Timeout');
      },
      count: async () => 1,
    }) }),
  };
  return page;
}

test('slow editor retries once before any submission', async () => {
  const page = pageMock(1);
  await runtime().aguardarEditor(page);
  assert.equal(page.reloads, 1);
});

test('missing editor returns actionable error after bounded retries', async () => {
  const page = pageMock(2);
  await assert.rejects(runtime().aguardarEditor(page), { status: 503 });
  assert.equal(page.reloads, 1);
});

test('expired login asks for authentication without reloading', async () => {
  const page = pageMock(2);
  await assert.rejects(runtime(undefined, false).aguardarEditor(page), { status: 401 });
  assert.equal(page.reloads, 0);
});
