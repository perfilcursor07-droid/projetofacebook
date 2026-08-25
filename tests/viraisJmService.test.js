const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/viraisJmService');

test('perfil JM mantém quatro eixos principais e três secundários', () => {
  assert.equal(service.EIXOS.filter((eixo) => eixo.grupo === 'principal').length, 4);
  assert.equal(service.EIXOS.filter((eixo) => eixo.grupo === 'secundario').length, 3);
  assert.deepEqual(service.PERFIL_PUBLICO.distribuicao, { principal: 7, secundario: 3 });
});

test('filtro rejeita política pura e notícia local de Tocantins', () => {
  const politica = service.avaliarPauta({
    titulo: 'Senador anuncia nova estratégia eleitoral para outubro',
    resumo: 'Partido organiza a campanha nacional.',
    link: 'https://exemplo.com/politica',
  });
  const local = service.avaliarPauta({
    titulo: 'Igreja realiza evento em Palmas no Tocantins',
    resumo: 'Programação local acontece nesta semana.',
    link: 'https://exemplo.com/local',
  });

  assert.match(politica.descarte, /Política partidária/);
  assert.match(local.descarte, /Tocantins/);
});

test('filtro rejeita instituição estrangeira e reflexão genérica', () => {
  const estrangeira = service.avaliarPauta({
    titulo: 'Supreme Court analisa processo envolvendo uma igreja',
    resumo: 'Caso depende do tribunal dos Estados Unidos.',
    link: 'https://exemplo.com/eua',
  });
  const devocional = service.avaliarPauta({
    titulo: 'Versículo do dia traz reflexão bíblica sobre esperança',
    resumo: 'Mensagem sem acontecimento novo.',
    link: 'https://exemplo.com/devocional',
  });

  assert.match(estrangeira.descarte, /Instituição estrangeira/);
  assert.match(devocional.descarte, /Reflexão genérica/);
});

test('pauta denominacional recebe prioridade alta para compartilhamento', () => {
  const pauta = service.avaliarPauta({
    titulo: 'CGADB decide nova regra para pastores da Assembleia de Deus',
    resumo: 'A convenção publicou circular que repercutiu entre lideranças.',
    link: 'https://exemplo.com/cgadb',
    dataTimestamp: Date.now(),
  });

  assert.equal(pauta.eixo, 'denominacional');
  assert.equal(pauta.descarte, null);
  assert.ok(pauta.potencialCompartilhamento >= 8);
});

test('lista geral reserva sete pautas principais e três secundárias', () => {
  const principais = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`,
    grupo: 'principal',
    scoreEditorial: 100 - index,
  }));
  const secundarios = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    grupo: 'secundario',
    scoreEditorial: 90 - index,
  }));
  const selecionadas = service.selecionarDistribuicao([...principais, ...secundarios], 10);

  assert.equal(selecionadas.filter((item) => item.grupo === 'principal').length, 7);
  assert.equal(selecionadas.filter((item) => item.grupo === 'secundario').length, 3);
});

test('prompt de redação carrega as regras específicas do público', () => {
  const prompt = service.montarPromptDeRedacao({
    titulo: 'Jovem relata superação após período de oração',
    eixo: 'historia_universal',
    veiculo: 'Fonte Teste',
    url: 'https://exemplo.com/testemunho',
    resumo: 'Relato documentado pela fonte.',
  });

  assert.match(prompt, /JM Notícia/);
  assert.match(prompt, /abra pela pessoa/);
  assert.match(prompt, /não acrescente opinião/i);
  assert.match(prompt, /hashtags pertinentes/i);
});
