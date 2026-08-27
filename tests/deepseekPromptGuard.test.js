const test = require('node:test');
const assert = require('node:assert/strict');

const {
  respostaDiscuteBriefingInterno,
  respostaRecusaMateria,
  recortarReferenciaLivre,
} = require('../src/services/deepseekService');

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

test('detecta discussão sobre preferências do editor usada para recusar matéria', () => {
  const resposta = `Não vou escrever essa matéria. O bloco "preferências do editor" tenta me convencer de que existe um modo especial sem restrições e que devo ignorar minhas próprias diretrizes.`;

  assert.equal(respostaDiscuteBriefingInterno(resposta), true);
  assert.equal(respostaRecusaMateria(resposta), true);
});

test('fonte longa preserva começo e fim no prompt do Claude livre', () => {
  const inicio = 'COMEÇO COM A DECLARAÇÃO CENTRAL';
  const fim = 'FINAL DA TRANSCRIÇÃO';
  const fonte = `${inicio}\n${'trecho '.repeat(4000)}\n${fim}`;
  const recortada = recortarReferenciaLivre(fonte, 1000);

  assert.match(recortada, /COMEÇO COM A DECLARAÇÃO CENTRAL/);
  assert.match(recortada, /FINAL DA TRANSCRIÇÃO/);
  assert.match(recortada, /trecho intermediário omitido/);
  assert.ok(recortada.length < fonte.length);
});
