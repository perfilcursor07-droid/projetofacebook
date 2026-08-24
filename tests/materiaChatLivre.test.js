const assert = require('node:assert/strict');
const test = require('node:test');

const {
  interpretarRespostaLivreParaRascunho,
} = require('../src/services/materiaChatService');

test('Claude livre salva somente a matéria após preâmbulo e título em negrito', () => {
  const resposta = String.raw`I encontrei um bom ângulo real e polêmico. Segue a matéria:

\*\*Pastor provoca a cúpula da CGADB: "Enriquecimento tem espantado muita gente"\*\*

DENTRO DA MAIOR CONVENÇÃO EVANGÉLICA DO BRASIL, UM PASTOR PEDE DEBATE

Em julho de 2026, o pastor publicou um posicionamento que abriu o debate sobre a liderança da convenção e sua relação com a política. Este primeiro parágrafo contém informações suficientes para compor o início da matéria.

Questionado pelo \<a\>JM Notícia\</a\>, ele citou mudanças na liturgia e o enriquecimento de líderes como pontos sensíveis. A declaração provocou reação entre integrantes da própria denominação.

Até o momento, a entidade não respondeu publicamente aos questionamentos apresentados pelo pastor.

Fonte: JM Notícia
Foto: Reprodução/CGADB

\#CGADB \#AssembleiaDeDeus \#Polemica`;

  const resultado = interpretarRespostaLivreParaRascunho(resposta);

  assert.equal(
    resultado.titulo,
    'Pastor provoca a cúpula da CGADB: "Enriquecimento tem espantado muita gente"'
  );
  assert.doesNotMatch(resultado.corpo, /encontrei um bom ângulo/i);
  assert.doesNotMatch(resultado.corpo, /Segue a matéria/i);
  assert.doesNotMatch(resultado.corpo, /Fonte:|Foto:|<a>|\\/i);
  assert.match(resultado.corpo, /Questionado pelo JM Notícia/);
  assert.deepEqual(resultado.hashtags, ['CGADB', 'AssembleiaDeDeus', 'Polemica']);
});

test('título revisado pelo usuário prevalece no rascunho do Claude livre', () => {
  const resposta = `# Título sugerido pelo Claude

Este é um primeiro parágrafo longo o bastante para explicar o fato apurado e preparar o restante do texto jornalístico que será salvo no sistema.

Este é o segundo parágrafo, também com conteúdo suficiente para que a resposta possa ser transformada em rascunho sem incluir conversa adicional.`;

  const resultado = interpretarRespostaLivreParaRascunho(resposta, 'Título final do editor');
  assert.equal(resultado.titulo, 'Título final do editor');
  assert.doesNotMatch(resultado.corpo, /Título sugerido/);
});
