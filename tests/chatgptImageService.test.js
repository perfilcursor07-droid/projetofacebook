const assert = require('node:assert/strict');
const test = require('node:test');

const { promptPadrao, promptComFormatoFacebook, cookiesDoHeader } = require('../src/services/chatgptImageService');

test('prompt de imagem pede reconstrução baseada na referência e sem texto', () => {
  const prompt = promptPadrao({
    titulo: 'Liderança comenta decisão durante encontro público',
    materia: 'A matéria descreve uma reunião e registra a reação dos participantes.',
  });

  assert.match(prompt, /imagem de referência/i);
  assert.match(prompt, /nova imagem editorial fotorrealista/i);
  assert.match(prompt, /não inclua texto/i);
  assert.match(prompt, /logotipos, marcas d’água/i);
  assert.match(prompt, /vertical.*4:5/i);
  assert.match(prompt, /1080 × 1350/i);
  assert.match(prompt, /Liderança comenta decisão/i);
});

test('formato do feed do Facebook é obrigatório mesmo em prompt personalizado', () => {
  const prompt = promptComFormatoFacebook('Deixe a pessoa com expressão triste.');

  assert.match(prompt, /Deixe a pessoa com expressão triste/);
  assert.match(prompt, /REGRA OBRIGATÓRIA DE FORMATO/);
  assert.match(prompt, /proporção EXATA 4:5/);
  assert.match(prompt, /1080 × 1350 pixels/);
  assert.match(prompt, /Não entregue imagem quadrada nem horizontal/);
});

test('cookies do ChatGPT usam URL host-only aceita pelo Chrome', () => {
  const cookies = cookiesDoHeader(
    '__Host-next-auth.csrf-token=abc123; __Secure-next-auth.session-token.0=parteA; oai-did=device'
  );

  assert.equal(cookies.length, 3);
  for (const cookie of cookies) {
    assert.equal(cookie.url, 'https://chatgpt.com/');
    assert.equal(cookie.secure, true);
    assert.equal('domain' in cookie, false);
    assert.equal('path' in cookie, false);
  }
});
