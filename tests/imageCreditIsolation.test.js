const test = require('node:test');
const assert = require('node:assert/strict');

const {
  atualizarCreditoImagemNaMateria,
  atualizarFonteCreditoDaImagem,
  normalizarCreditosImagemDuplicados,
} = require('../src/services/editorialGuidelinesFb');

test('trocar foto preserva integralmente a fonte jornalística da matéria', () => {
  const materia = [
    'Primeiro parágrafo da matéria.',
    '',
    'Segundo parágrafo factual.',
    '',
    'Fonte: Chat de matérias + pesquisa na web, G1',
    '',
    'Foto: Reprodução',
    '',
    '#Notícia #JMNotícia',
  ].join('\n');

  const atualizada = atualizarCreditoImagemNaMateria(materia, 'Agência Brasil');

  assert.match(atualizada, /^Fonte: Chat de matérias \+ pesquisa na web, G1$/m);
  assert.match(atualizada, /^Foto: Agência Brasil$/m);
  assert.equal((atualizada.match(/Foto:/g) || []).length, 1);
});

test('repara Foto duplicada e colada na Fonte sem reescrever a fonte', () => {
  const materia = 'Fonte: Chat de matérias + pesquisa na web, G1 Foto: Reprodução Foto: Reprodução';
  const atualizada = atualizarCreditoImagemNaMateria(materia, 'Reprodução/Internet');

  assert.match(atualizada, /^Fonte: Chat de matérias \+ pesquisa na web, G1$/m);
  assert.match(atualizada, /^Foto: Reprodução$/m);
  assert.equal((atualizada.match(/Foto:/g) || []).length, 1);
});

test('campo fonte_credito mantém nomes e URLs e troca apenas a imagem', () => {
  const credito = [
    'Fonte:',
    '• G1 — https://g1.globo.com/noticia',
    '• UOL — https://noticias.uol.com.br/noticia',
    '',
    '(Foto: Reprodução)',
  ].join('\n');

  const atualizado = atualizarFonteCreditoDaImagem(credito, 'João Silva/Agência X');

  assert.match(atualizado, /• G1 — https:\/\/g1\.globo\.com\/noticia/);
  assert.match(atualizado, /• UOL — https:\/\/noticias\.uol\.com\.br\/noticia/);
  assert.match(atualizado, /^\(Foto: João Silva\/Agência X\)$/m);
  assert.equal((atualizado.match(/Foto:/g) || []).length, 1);
});

test('sem novo autor o campo de fontes não é normalizado nem ampliado', () => {
  const credito = 'Fonte: Chat de matérias + pesquisa na web';
  assert.equal(atualizarFonteCreditoDaImagem(credito, null, { fonteUrl: 'https://g1.globo.com' }), credito);
});

test('ao reabrir matéria antiga remove Foto duplicada sem alterar a Fonte', () => {
  const antigo = 'Fonte: Chat de matérias + pesquisa na web, G1 Foto: Reprodução Foto: Reprodução';
  const reparado = normalizarCreditosImagemDuplicados(antigo);

  assert.match(reparado, /^Fonte: Chat de matérias \+ pesquisa na web, G1$/m);
  assert.match(reparado, /^Foto: Reprodução$/m);
  assert.equal((reparado.match(/Foto:/g) || []).length, 1);
});
