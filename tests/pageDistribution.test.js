const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const editorial = require('../src/services/pageDistributionEditorial');

function harness() {
  const tables = { page_distribution_settings: [], page_distribution_targets: [], page_distribution_items: [], publications: [] };
  function db(table) {
    const predicates = []; let op, values, conflict;
    const query = {
      where(key, value, third) {
        predicates.push(typeof key === 'object' ? (r) => Object.entries(key).every(([k,v]) => r[k] === v)
          : value === '<' ? (r) => r[key] < third : (r) => r[key] === value); return query;
      },
      whereIn(k, v) { predicates.push((r) => v.includes(r[k])); return query; },
      whereNotNull(k) { predicates.push((r) => r[k] != null); return query; },
      insert(v) { op = 'insert'; values = v; return query; },
      update(v) { op = 'update'; values = v; return query; },
      onConflict(v) { conflict = Array.isArray(v) ? v : [v]; return query; },
      ignore() { return query; },
      forUpdate() { return query; },
      merge(fields) { query.mergeFields = fields || Object.keys(values); return query; },
      first() { return query.then((rows) => rows[0]); },
      then(resolve, reject) {
        try {
          const rows = table === 'ai_matters' ? [...matterMap.values()] : tables[table]; let result;
          if (op === 'insert') {
            const existing = conflict && rows.find((r) => conflict.every((k) => r[k] === values[k]));
            if (existing) { for (const k of query.mergeFields || []) existing[k] = values[k]; result = [existing.id]; }
            else { const r = { id: rows.length + 1, state: 'pending', selected: false, updated_at: new Date(), ...values }; rows.push(r); result = [r.id]; }
          } else {
            const matches = rows.filter((r) => predicates.every((f) => f(r)));
            if (op === 'update') { matches.forEach((r) => Object.assign(r, values)); result = matches.length; }
            else result = matches.map((r) => ({ ...r }));
          }
          return Promise.resolve(result).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    }; return query;
  }
  db.fn = { now: () => new Date() }; db.transaction = (fn) => fn(db);
  const matterMap = new Map([[1, { id: 1, user_id: 7, titulo: 'Pastor morre', materia: 'Fatos apurados da matéria principal.', tipo_publicacao: 'texto', status: 'rascunho' }]]);
  const ownedPages = [{ id: 10, page_name: 'Página A' }, { id: 11, page_name: 'Página B' }];
  const tasks = []; const sends = []; let failPage = null; let generations = 0;
  const filename = path.resolve(__dirname, '../src/services/pageDistributionService.js');
  const realRequire = createRequire(filename);
  const mocks = {
    '../config/db': db,
    '../models/AiMatters': {
      findById: async (id) => matterMap.get(id),
      create: async (data) => { const id = matterMap.size + 1; matterMap.set(id, { id, ...data }); return [id]; },
      update: async (id, data) => Object.assign(matterMap.get(id), data),
    },
    '../models/Users': { findById: async () => ({ id: 7, marca_cor_primaria: '#ffbd59', api_secret: 'never-copy' }) },
    './facebookPageResolver': { pagesForUser: async (id) => id === 7 ? ownedPages : [],
      resolvePageForUser: async (u,id) => u === 7 ? ownedPages.find((p) => p.id === id) : null },
    './pageDistributionEditorial': { ...editorial, generateVariation: async (_source, page) => {
      generations++; return { titulo: 'Versão ' + page.page_name, materia: 'Conteúdo para ' + page.page_name };
    } },
    '../workers/queue': { enqueue: (_name, fn) => tasks.push(fn) },
    '../config/env': { env: { storagePath: '/not-used' } },
    './materiaIaService': { publicarMateria: async (_u,id,opts) => {
      sends.push({ id, ...opts });
      if (opts.facebook_page_id === failPage) throw new Error('Timeout do provedor');
      matterMap.get(id).publication_id = 100 + id;
      return { postId: 'post-' + id };
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), module, exports: module.exports, console, Date,
  }, { filename });
  return { service: module.exports, tables, matterMap, sends, tasks, ownedPages,
    drain: async () => { while (tasks.length) await tasks.shift()(); },
    fail: (id) => { failPage = id; }, generations: () => generations };
}

test('seleção é isolada por usuário e preserva marca ao atualizar páginas', async () => {
  const h = harness();
  await assert.rejects(h.service.saveSettings(7, { enabled: true, pageIds: [999] }), /não pertence/);
  await h.service.saveSettings(7, { enabled: true, pageIds: [10,11] });
  h.tables.page_distribution_targets[0].brand = '{"marca_nome":"Especial"}';
  await h.service.saveSettings(7, { enabled: false, pageIds: [10] });
  assert.equal(h.tables.page_distribution_targets[0].brand, '{"marca_nome":"Especial"}');
  assert.equal((await h.service.settings(8)).pages.length, 0);
  await assert.rejects(h.service.prepare(8,1), /não encontrada/);
  assert.equal(h.sends.length, 0);
});

test('cliques concorrentes geram uma versão por página e nunca publicam durante preparo', async () => {
  const h = harness();
  await h.service.saveSettings(7, { enabled: true, pageIds: [10,11] });
  await Promise.all([h.service.prepare(7,1), h.service.prepare(7,1)]);
  await h.drain();
  assert.equal(h.generations(), 2);
  assert.equal(h.matterMap.size, 3);
  assert.equal(h.sends.length, 0);
  assert.equal(h.matterMap.get(1).status, 'rascunho');
  const result = await h.service.status(7,1);
  assert.equal(result.items.filter((r) => r.state === 'ready').length, 2);
  assert.equal((await h.service.status(7,2)).enabled, false, 'variante não cria outro grupo');
});

test('envio parcial e duplo clique não reenviam páginas nem repetem timeouts', async () => {
  const h = harness();
  await h.service.saveSettings(7, { enabled: true, pageIds: [10,11] });
  await h.service.prepare(7,1); await h.drain(); h.fail(11);
  await Promise.all([h.service.publish(7,1), h.service.publish(7,1)]); await h.drain();
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends.map((r) => r.facebook_page_id), [10,11]);
  assert.equal(h.tables.page_distribution_items[0].state, 'sent');
  assert.equal(h.tables.page_distribution_items[1].state, 'uncertain');
  await h.service.publish(7,1); await h.drain(); assert.equal(h.sends.length, 2);
});

test('mudança na principal, desativação e destino alterado bloqueiam envio', async () => {
  const h = harness();
  await h.service.saveSettings(7, { enabled: true, pageIds: [10] });
  await h.service.prepare(7,1); await h.drain();
  h.matterMap.get(1).titulo = 'Mudou';
  await assert.rejects(h.service.publish(7,1), /principal mudou/);
  await h.service.prepare(7,1); await h.drain();
  h.matterMap.get(2).facebook_page_id = 11;
  await assert.rejects(h.service.publish(7,1), /Destino/);
  await h.service.saveSettings(7, { enabled: false, pageIds: [10] });
  await assert.rejects(h.service.publish(7,1), /desativada/);
  assert.equal(h.sends.length, 0);
});

test('marca própria não muda usuário e preserva cores nos ajustes do modelo', async () => {
  const h = harness();
  await h.service.saveBrand(7,10,{ custom: true, model: 'jm', name: 'Marca B', primary: '#112233', secondary: '#445566' });
  const brand = JSON.parse(h.tables.page_distribution_targets[0].brand);
  assert.equal(brand.api_secret, undefined);
  assert.equal(JSON.parse(brand.marca_modelo_config).jm.corPrimaria, '#112233');
  const user = { id: 7, marca_nome: 'Original' };
  const effective = editorial.effectiveBrand(user, { distribution_brand: JSON.stringify(brand) });
  assert.equal(effective.marca_nome, 'Marca B'); assert.equal(user.marca_nome, 'Original');
  await h.service.saveBrand(7,10,{custom:false});
  assert.equal(h.tables.page_distribution_targets[0].brand, null);
});

test('resposta inválida ou repetida não passa na validação editorial', () => {
  assert.throws(() => editorial.validateVariation('{}', []), /válidos/);
  assert.throws(() => editorial.validateVariation(JSON.stringify({ titulo:'Título igual', materia:'Texto longo '.repeat(20) }),
    [{titulo:'TÍTULO IGUAL',materia:'Outro'}]), /repetiu/);
  const out = editorial.validateVariation(JSON.stringify({ titulo:'Novo título', materia:'Texto longo '.repeat(20) }), []);
  assert.equal(out.titulo,'Novo título');
});

test('editor preserva principal e exige ação de publicar depois do preparo', async () => {
  const { JSDOM } = require('jsdom');
  const ejs = require('ejs');
  const template = fs.readFileSync(path.resolve(__dirname, '../public/views/partials/page-distribution.ejs'), 'utf8');
  const dom = new JSDOM(ejs.render(template, { mode: 'editor', matterId: 1 }), { runScripts: 'outside-only', url: 'http://localhost:3000' });
  const w = dom.window;
  const calls = [];
  let prepared = false;
  const response = () => ({ enabled: true, pages: [{id:10,name:'Página A'}], items: prepared
    ? [{id:1,pageId:10,pageName:'Página A',selected:true,state:'ready',matterId:2,title:'Título',text:'Texto',stale:false}] : [] });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.saveMatterForDistribution = async () => { calls.push('save'); };
  w.fetch = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/prepare')) prepared = true;
    return { ok: true, json: async () => response() };
  };
  try {
    w.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/page-distribution.js'), 'utf8'));
    await new Promise(setImmediate);
    assert.equal(calls.some((url) => url.endsWith('/publish')), false);
    await w.pageDistribution.handlePublish();
    assert.equal(calls.filter((url) => url.endsWith('/prepare')).length, 1);
    assert.equal(calls.some((url) => url.endsWith('/publish')), false);
    await Promise.all([w.pageDistribution.handlePublish(), w.pageDistribution.handlePublish()]);
    assert.equal(calls.filter((url) => url.endsWith('/publish')).length, 1);
    assert.equal(calls.some((url) => url === '/api/materias-ia/matters/1/publicar'), false);
  } finally { w.close(); }
});

test('recupera falha antiga, preserva histórico e não libera destinos enviados', async () => {
  const h = harness();
  await h.service.saveSettings(7, { enabled: true, pageIds: [10,11] });
  await h.service.prepare(7,1); await h.drain();
  const [a,b] = h.tables.page_distribution_items;
  a.state = 'sent';
  b.state = 'uncertain'; b.error = 'A Página está sem Profile Key da Ayrshare.';
  h.matterMap.get(b.matter_id).publication_id = 999;
  h.matterMap.get(b.matter_id).status = 'erro';
  h.tables.publications.push({id:999,status:'erro'});
  assert.equal((await h.service.status(7,1)).items[1].state, 'blocked');
  await h.service.retry(7,1,b.id,false);
  assert.equal(h.matterMap.get(b.matter_id).publication_id,null);
  assert.equal(h.tables.publications.length,1);
  assert.equal(a.state,'sent');
  await assert.rejects(h.service.retry(7,1,a.id,true), /não está disponível/);
  await h.service.publish(7,1); await h.drain();
  assert.deepEqual(h.sends.map(s=>s.facebook_page_id),[11]);
});

test('timeout exige conferência e publicação pendente não pode ser liberada', async () => {
  const h = harness();
  await h.service.saveSettings(7,{enabled:true,pageIds:[10]});
  await h.service.prepare(7,1); await h.drain();
  const row=h.tables.page_distribution_items[0];
  row.state='uncertain'; row.error='Timeout';
  await assert.rejects(h.service.retry(7,1,row.id,false),/Confirme/);
  h.matterMap.get(row.matter_id).publication_id=55;
  h.tables.publications.push({id:55,status:'pendente'});
  await assert.rejects(h.service.retry(7,1,row.id,true),/pendente/);
  await assert.rejects(h.service.retry(8,1,row.id,true),/não encontrada/);
  assert.equal(row.state,'uncertain');
});

test('classifica somente rejeições explícitas como bloqueio', () => {
  const {failureState}=require('../src/services/distributionFailure');
  assert.equal(failureState('Meta is requesting additional identity verification for this account.'),'blocked');
  assert.equal(failureState('A Página está sem Profile Key da Ayrshare.'),'blocked');
  assert.equal(failureState('Timeout do provedor'),'uncertain');
});
