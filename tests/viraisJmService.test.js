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

test('filtro separa história universal de agenda institucional estrangeira', () => {
  const institucional = service.avaliarPauta({
    titulo: 'Convenção das Assembleias de Deus no Japão elege nova diretoria',
    resumo: 'A COMADEJA realizou sua assembleia anual.',
    link: 'https://exemplo.com/japao',
    eixoPesquisa: 'denominacional',
  }, 'denominacional');
  const humana = service.avaliarPauta({
    titulo: 'Jovem supera diagnóstico após meses de tratamento e oração',
    resumo: 'O testemunho termina com recuperação e esperança.',
    link: 'https://exemplo.com/historia',
    eixoPesquisa: 'historia_universal',
  }, 'historia_universal');

  assert.match(institucional.descarte, /institucional estrangeira/);
  assert.equal(humana.descarte, null);
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

test('consulta editorial sozinha não faz uma pauta pertencer ao segmento', () => {
  const pauta = service.avaliarPauta({
    titulo: 'Nova decisão provoca reação entre os membros',
    resumo: 'A circular foi divulgada nesta segunda-feira.',
    link: 'https://exemplo.com/decisao',
    eixoPesquisa: 'denominacional',
  }, 'denominacional');

  assert.match(pauta.descarte, /Sem fato concreto/);
  assert.equal(pauta.eixo, 'denominacional');
});

test('filtro bloqueia as cinco sugestões fracas vistas na tela de Virais', () => {
  const exemplos = [
    {
      titulo: 'Idosa de 99 anos aceita Jesus minutos antes de falecer: “Partiu para a eternidade”',
      resumo: 'A igreja divulgou o testemunho de conversão.',
      eixoPesquisa: 'denominacional',
    },
    {
      titulo: 'Thalles Roberto: biografia, idade, esposa, filhos e músicas',
      resumo: 'Conheça a carreira do cantor gospel.',
      eixoPesquisa: 'polemica_gospel',
    },
    {
      titulo: 'Ensinar o comunismo para não repetir a história',
      resumo: 'Artigo sobre política e história.',
      eixoPesquisa: 'memoria',
    },
    {
      titulo: 'Que fragrância você deixa por onde passa?',
      resumo: 'Reflexão cristã para o dia.',
      eixoPesquisa: 'historia_universal',
    },
    {
      titulo: 'Líderes da Igreja na Palestina virão ao Brasil',
      resumo: 'Representantes participarão de uma agenda institucional.',
      eixoPesquisa: 'historia_universal',
    },
  ].map((pauta, index) => service.avaliarPauta({
    ...pauta,
    link: `https://exemplo.com/ruim-${index}`,
  }, pauta.eixoPesquisa));

  assert.ok(exemplos.every((pauta) => pauta.descarte));
  assert.match(exemplos[0].descarte, /Morte ou tragédia/);
  assert.match(exemplos[1].descarte, /Biografia ou lista/);
  assert.match(exemplos[2].descarte, /opinião/);
  assert.match(exemplos[3].descarte, /Reflexão genérica/);
  assert.match(exemplos[4].descarte, /Agenda institucional/);
});

test('filtro mantém fato denominacional recente e história concreta de superação', () => {
  const denominacional = service.avaliarPauta({
    titulo: 'CGADB publica circular e muda regra para ordenação de presbíteros',
    resumo: 'A decisão da convenção provocou reação entre pastores da Assembleia de Deus.',
    link: 'https://exemplo.com/circular-cgadb',
  });
  const superacao = service.avaliarPauta({
    titulo: 'Jovem volta a andar após tratamento e relata apoio da igreja',
    resumo: 'A família celebrou a recuperação depois de meses de tratamento e oração.',
    link: 'https://exemplo.com/superacao',
  });

  assert.equal(denominacional.descarte, null);
  assert.equal(denominacional.eixo, 'denominacional');
  assert.equal(superacao.descarte, null);
  assert.equal(superacao.eixo, 'historia_universal');
});

test('consultas padrão são curtas para não zerar o Google News', () => {
  const consultas = service.consultasDaPesquisa({ eixo: 'all' });

  assert.equal(consultas.length, 7);
  assert.ok(consultas.every((item) => item.consulta.split(/\s+/).length <= 4));
});

test('prompt pede pesquisa nativa seletiva e permite retornar poucas pautas', () => {
  const prompt = service.montarPromptPesquisaClaude({ periodo: '7d', limite: 10 });

  assert.match(prompt, /Use obrigatoriamente a pesquisa na web/);
  assert.match(prompt, /não complete a quantidade com pautas fracas/i);
  assert.match(prompt, /biografia, perfil, lista de músicas/i);
  assert.match(prompt, /Retorne SOMENTE JSON válido/i);
});

test('normalização do resultado do Claude mantém apenas pauta com fonte e eixo válidos', () => {
  const pautas = service.normalizarPautasClaude(`Pesquisa concluída.\n${JSON.stringify({
    pautas: [
      {
        titulo: 'CGADB publica decisão que muda regra interna',
        resumo: 'A convenção publicou uma circular e dirigentes reagiram à mudança.',
        url: 'https://exemplo.com/cgadb-regra',
        veiculo: 'Fonte Teste',
        data: '2026-08-24',
        eixo: 'denominacional',
        potencial: 9,
        motivo: 'Decisão concreta com repercussão assembleiana',
      },
      {
        titulo: 'Pauta inventada sem fonte',
        resumo: 'Não possui URL.',
        eixo: 'polemica_gospel',
      },
      {
        titulo: 'Pauta com eixo inexistente',
        resumo: 'Tem URL, mas não pertence ao perfil.',
        url: 'https://exemplo.com/invalida',
        eixo: 'celebridades',
      },
    ],
  })}\nUsei somente fontes diretas.`);

  assert.equal(pautas.length, 1);
  assert.equal(pautas[0].origemPesquisa, 'claude');
  assert.equal(pautas[0].potencialClaude, 9);
  assert.equal(pautas[0].dataTimestamp, Date.parse('2026-08-24'));
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
