const assert = require('node:assert/strict');
const test = require('node:test');

const { promptPadrao } = require('../src/services/chatgptImageService');

test('prompt de imagem pede reconstrução baseada na referência e sem texto', () => {
  const prompt = promptPadrao({
    titulo: 'Liderança comenta decisão durante encontro público',
    materia: 'A matéria descreve uma reunião e registra a reação dos participantes.',
  });

  assert.match(prompt, /imagem de referência/i);
  assert.match(prompt, /nova imagem editorial fotorrealista/i);
  assert.match(prompt, /não inclua texto/i);
  assert.match(prompt, /logotipos, marcas d’água/i);
  assert.match(prompt, /vertical 4:5/i);
  assert.match(prompt, /Liderança comenta decisão/i);
});
