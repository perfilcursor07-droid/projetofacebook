const test = require('node:test');
const assert = require('node:assert/strict');
const { removerComentariosEditoriaisIa } = require('../src/services/editorialGuidelinesFb');
const { serializarMensagem, separarMaterias } = require('../src/services/materiaChatService');

test('limpeza e resposta enviada ao navegador preservam cinco rascunhos', () => {
  const temas = ['Origem histórica do dízimo', 'Abraão e Melquisedeque no debate', 'Interpretação de Hebreus pelos participantes', 'Igreja e instituição na discussão', 'Nova aliança e prática espiritual'];
  const lote = temas.map((tema, i) => `### MATÉRIA ${i + 1}\n**${tema}**\n\n${'Os participantes apresentaram argumentos documentados no vídeo, com posições atribuídas aos respectivos autores. '.repeat(3)}\n\n${'A discussão inclui o contexto da declaração e os pontos de discordância registrados na transcrição. '.repeat(3)}\n\nFonte: Canal do vídeo\n\n#Debate #Fé\n\nSiga o JM Notícia.\n\nTítulos alternativos:\n1. Sugestão que não pertence ao corpo`).join('\n\n');
  const limpa = removerComentariosEditoriaisIa(lote);
  const resposta = serializarMensagem({ id: 1, role: 'assistant', content: limpa, fontes: JSON.stringify([{ veiculo: 'Canal', url: 'https://youtube.com/watch?v=teste' }]), matter_ids: '{"1":42}' });
  assert.equal(separarMaterias(limpa).length, 5);
  assert.equal(resposta.materias.length, 5);
  for (const [i, materia] of resposta.materias.entries()) {
    assert.ok(materia.titulo.includes(temas[i]));
    assert.equal(materia.salvavel, true);
    assert.equal(materia.indice, i);
  }
  assert.equal(resposta.materias[1].matterId, 42);
  assert.doesNotMatch(resposta.content, /Títulos alternativos/);
});
