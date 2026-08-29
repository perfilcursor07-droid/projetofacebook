const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  blocoCriteriosMateriaManual,
  blocoEstiloJmNoticia,
} = require('../src/services/editorialGuidelinesFb');
const { priorizarFontesIndependentes } = require('../src/services/materiaIaService');

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

test('critérios compartilhados distinguem pesquisa ligada e desligada', () => {
  const comPesquisa = blocoCriteriosMateriaManual({ pesquisa: true });
  const semPesquisa = blocoCriteriosMateriaManual({ pesquisa: false });

  assert.match(comPesquisa, /duas fontes independentes/i);
  assert.match(comPesquisa, /elemento factual que não esteja na fonte principal/i);
  assert.match(semPesquisa, /somente o link, texto, legenda ou transcrição/i);
  assert.match(semPesquisa, /não acrescente contexto de memória/i);
  for (const prompt of [comPesquisa, semPesquisa]) {
    assert.match(prompt, /3 a 6 parágrafos/i);
    assert.match(prompt, /2\.200 caracteres/i);
    assert.match(prompt, /lição moral, oração ou pergunta de engajamento/i);
    assert.match(prompt, /reacendeu o debate/i);
  }
});

test('geradores direto e pesquisado recebem os critérios editoriais compartilhados', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'deepseekService.js'),
    'utf8'
  );

  assert.match(source, /blocoCriteriosMateriaManual\(\{ pesquisa: false \}\)/);
  assert.match(source, /blocoCriteriosMateriaManual\(\{ pesquisa: true \}\)/);
});

test('apuração prioriza fontes de domínios independentes', () => {
  const fontes = priorizarFontesIndependentes([
    { url: 'https://portal-a.test/noticia-principal', titulo: 'Principal' },
    { url: 'https://portal-a.test/contexto', titulo: 'Mesmo portal' },
    { url: 'https://portal-b.test/confirmacao', titulo: 'Fonte independente' },
  ]);

  assert.deepEqual(fontes.map((fonte) => fonte.titulo), [
    'Principal',
    'Fonte independente',
    'Mesmo portal',
  ]);
});

test('Mais lidas possui agrupamento e filtro por fonte', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'materia-chat-extras.js'),
    'utf8'
  );

  assert.match(source, /Filtrar matérias mais lidas por fonte/);
  assert.match(source, /mia-x-source-group/);
  assert.match(source, /aplicarFiltroFonte/);
  assert.match(source, /Todas as fontes/);
});
