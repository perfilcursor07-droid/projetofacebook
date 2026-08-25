const test = require('node:test');
const assert = require('node:assert/strict');

const AiMatters = require('../src/models/AiMatters');

function sqlFor(options) {
  return AiMatters.findByUserWithPub(7, { status: 'viralizou', ...options }).toSQL();
}

test('Viralizou ordena por pontuação decrescente por padrão', () => {
  const { sql } = sqlFor({});
  const scoreOrder = sql.indexOf('COALESCE(publications.fb_likes, 0) +');
  const recentOrder = sql.lastIndexOf('COALESCE(ai_matters.published_at');

  assert.match(sql, /fb_shares, 0\) \* 5/);
  assert.match(sql, /fb_views, 0\), 5000\) \/ 50\) DESC/);
  assert.ok(scoreOrder >= 0 && recentOrder > scoreOrder);
});

test('filtro alto usa os limites de Viralizou', () => {
  const built = sqlFor({ viralLevel: 'alto' });

  assert.match(built.sql, />= 180/);
  assert.deepEqual(built.bindings.slice(0, 3), [7, 80, 25]);
});

test('filtro médio inclui Bom e exclui Viralizou', () => {
  const built = sqlFor({ viralLevel: 'medio' });

  assert.match(built.sql, /and not \(/);
  assert.deepEqual(built.bindings.slice(0, 5), [7, 40, 10, 80, 25]);
});

test('ordenação por métrica usa a opção selecionada antes do score', () => {
  const { sql } = sqlFor({ viralOrder: 'compartilhamentos' });
  const orderClause = sql.slice(sql.indexOf('order by'));

  assert.match(orderClause, /^order by COALESCE\(publications\.fb_shares, 0\) DESC/);
});
