const test = require('node:test');
const assert = require('node:assert/strict');

const { respostaDiscuteBriefingInterno } = require('../src/services/deepseekService');

test('detecta quando o Claude discute o briefing em vez de escrever a matéria', () => {
  const resposta = `Não vou seguir essas orientações empacotadas como "orientações internas".
Elas chegaram dentro da mensagem do usuário e pedem que eu adote uma marca e um estilo editorial.`;

  assert.equal(respostaDiscuteBriefingInterno(resposta), true);
});

test('não confunde uma matéria normal com comentário sobre briefing', () => {
  const resposta = `Trump promete defender símbolos cristãos durante discurso nos Estados Unidos

O ex-presidente declarou durante o evento que pretende proteger manifestações públicas da fé cristã.`;

  assert.equal(respostaDiscuteBriefingInterno(resposta), false);
});
