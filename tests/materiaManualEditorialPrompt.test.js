const test = require('node:test');
const assert = require('node:assert/strict');

const {
  blocoEstiloJmNoticia,
} = require('../src/services/editorialGuidelinesFb');

test('prompt da matéria manual exige redação original e fatos somente da apuração', () => {
  const prompt = blocoEstiloJmNoticia({ pesquisa: true });

  assert.match(prompt, /Nunca escreva fatos a partir de memória/i);
  assert.match(prompt, /reescreva 100% com palavras próprias/i);
  assert.match(prompt, /como reportagem nossa, não como resenha/i);
  assert.match(prompt, /no mínimo duas fontes independentes/i);
  assert.match(prompt, /ao menos um elemento ausente na fonte principal/i);
  assert.match(prompt, /contexto factual/i);
  assert.match(prompt, /Corpo com 3 a 6 parágrafos/i);
  assert.match(prompt, /até 2\.200 caracteres no total/i);
});

test('prompt preserva rodapé, hashtags e chamada do JM sem fechamento opinativo', () => {
  const prompt = blocoEstiloJmNoticia({ pesquisa: false });

  assert.match(prompt, /Exatamente 5 hashtags pertinentes/i);
  assert.match(prompt, /quinta e última é #JMNotícia/i);
  assert.match(prompt, /Siga o JM Notícia/i);
  assert.match(prompt, /Fonte:\*\* nome — URL real/i);
  assert.match(prompt, /Foto:\*\* crédito real/i);
  assert.match(prompt, /não inclua pergunta para engajamento/i);
  assert.match(prompt, /Opinião, lição, alerta moral ou oração no fechamento/i);
  assert.match(prompt, /segundo a publicação/i);
  assert.match(prompt, /não recuse escrever/i);
});

