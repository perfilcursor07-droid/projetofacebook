const test = require('node:test');
const assert = require('node:assert/strict');
const { gerarPorAssunto } = require('../src/services/materiasPorAssunto');

test('um vídeo gera chamadas separadas para cada assunto comprovado', async () => {
  const material = 'Primeiro argumento documentado sobre a origem histórica. Segundo argumento documentado sobre doações a necessitados.';
  const chamadas = [];
  const resposta = await gerarPorAssunto({
    material, limite: 5,
    planejar: async () => JSON.stringify({ assuntos: [
      { tema: 'Origem histórica', evidencia: 'Primeiro argumento documentado sobre a origem histórica.' },
      { tema: 'Doações', evidencia: 'Segundo argumento documentado sobre doações a necessitados.' },
      { tema: 'Inventado', evidencia: 'Este trecho não existe no vídeo nem no material original.' },
    ] }),
    escrever: async (a) => { chamadas.push(a.tema); return a.tema + '\n\nCorpo da matéria.'; },
  });
  assert.deepEqual(chamadas, ['Origem histórica', 'Doações']);
  assert.match(resposta, /### MATÉRIA 1/);
  assert.match(resposta, /### MATÉRIA 2/);
  assert.doesNotMatch(resposta, /Inventado/);
});

test('falha de planejamento não vira uma matéria genérica silenciosamente', async () => {
  await assert.rejects(gerarPorAssunto({ material: 'fonte', limite: 5, planejar: async () => 'Não sei', escrever: async () => assert.fail('não deve escrever') }), /organizar os assuntos/);
});
