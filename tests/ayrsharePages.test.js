const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
const axios = require('axios');
const service = require('../src/services/ayrshareService');
const controller = require('../src/controllers/ayrshareController');
const db = require('../src/config/db');
const { env } = require('../src/config/env');

test('cadastro valida perfil antes de gravar e não duplica página', async (t) => {
  const rows = [];
  let account = null;
  let writes = 0;
  const profile = { refId: 'ref-test', facebookConnected: true, facebookPageId: '1234', facebookPageName: 'Página teste' };
  t.mock.method(service, 'isAyrshareApiKey', () => false);
  t.mock.method(service, 'fetchProfileByKey', async () => profile);
  t.mock.method(db, 'transaction', async (run) => {
    const trx = (table) => {
      const query = {
        where() { return this; }, forUpdate() { return this; },
        async first() { return table === 'users' ? { id: 7 } : account; },
        then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
        async insert(row) {
          writes++;
          if (table === 'facebook_accounts') account = { ...row, id: 9 };
          else rows.push({ ...row, id: 10 });
          return [10];
        },
        async update(patch) { Object.assign(rows[0], patch); },
      };
      return query;
    };
    trx.fn = { now: () => new Date() };
    return run(trx);
  });
  async function call(body) {
    let result, error;
    await controller.addPage({ session: { userId: 7 }, body }, { json: (data) => { result = data; } }, (err) => { error = err; });
    return { result, error };
  }
  assert.equal((await call({})).error.status, 400);
  assert.equal((await call({ profile_key: 'a'.repeat(40) })).error.status, 400);
  assert.equal((await call({ profile_key: 'key', ref_id: 'wrong' })).error.status, 422);
  profile.facebookConnected = false;
  assert.equal((await call({ profile_key: 'key' })).error.status, 422);
  assert.equal(writes, 0);
  profile.facebookConnected = true;
  const first = await call({ profile_key: 'key', ref_id: 'ref-test' });
  assert.equal(first.result.page.page_name, 'Página teste');
  assert.equal(rows[0].facebook_account_id, 9);
  assert.equal(account.user_id, 7);
  assert.equal((await call({ profile_key: 'key' })).result.page.existing, true);
  assert.equal(rows.length, 1);
  assert.equal((await call({ profile_key: 'other-key' })).error.status, 409);
});

test('consulta de perfis preserva paginação sem retornar chaves', async (t) => {
  const previous = env.ayrshare.apiKey;
  env.ayrshare.apiKey = 'test-only';
  t.after(() => { env.ayrshare.apiKey = previous; });
  t.mock.method(axios, 'get', async (url, options) => {
    assert.ok(url.endsWith('/profiles'));
    assert.equal(options.params.cursor, 'cursor-1');
    return { data: { profiles: [{ title: 'Perfil', refId: 'ref', status: 'active', activeSocialAccounts: ['facebook'], profileKey: 'secret' }], pagination: { hasMore: true, nextCursor: 'cursor-2' } } };
  });
  const result = await service.listProfiles({ cursor: 'cursor-1' });
  assert.equal(result.next_cursor, 'cursor-2');
  assert.equal(result.profiles[0].facebook_connected, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('template e scripts renderizam para administrador, usuário e outro provedor', () => {
  const source = fs.readFileSync('public/views/paginas.ejs', 'utf8');
  for (const role of ['administrador', 'usuario']) {
    for (const provider of ['ayrshare', 'postsyncer']) {
      const html = ejs.render(source, { include: () => '', publishProvider: provider, ayrshareConfigured: true, user: { nivel_acesso: role } });
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
      assert.equal(html.includes('id="ay-discover"'), provider === 'ayrshare' && role === 'administrador');
    }
  }
});
