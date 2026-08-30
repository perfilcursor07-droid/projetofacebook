const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const viewPath = path.join(__dirname, '..', 'public', 'views', 'materia-manual.ejs');

async function renderFor(accessLevel) {
  return ejs.renderFile(viewPath, {
    title: 'Matéria manual',
    currentPath: '/materia-manual',
    user: { id: 1, nome: 'Editor', nivel_acesso: accessLevel },
  });
}

test('administrador pode escolher o modelo diretamente no Matéria manual', async () => {
  const html = await renderFor('administrador');

  assert.match(html, /id="chat-ai-model-select"/);
  assert.match(html, /id="chat-ai-model-menu"/);
  assert.match(html, /aria-label="Escolher modelo de IA do Matéria manual"/);
  assert.match(html, /data-admin-model-selector="1"/);
});

test('usuário comum vê o modelo, mas não recebe o seletor administrativo', async () => {
  const html = await renderFor('usuario');

  assert.match(html, /id="chat-ai-model"/);
  assert.match(html, /data-admin-model-selector="0"/);
  assert.doesNotMatch(html, /id="chat-ai-model-select"/);
});

test('seletor lista somente provedores conectados e usa a rota administrativa protegida', () => {
  const client = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'materia-chat.js'),
    'utf8'
  );
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'accountPages.js'),
    'utf8'
  );

  assert.match(client, /filter\(\(provider\) => Boolean\(provider\.configured\)\)/);
  assert.match(client, /\/api\/admin\/ai-providers\/\$\{encodeURIComponent\(provider\)\}\/select/);
  assert.match(routes, /ai-providers\/:provider\/select', requireAuth, requireAdmin/);
});
