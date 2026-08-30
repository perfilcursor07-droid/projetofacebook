const assert = require('node:assert/strict');
const test = require('node:test');

const {
  interpretarRespostaLivreParaRascunho,
  respostaLivrePodeVirarMateria,
  extrairFontesDeclaradasRespostaLivre,
  selecionarFontesRespostaLivre,
  consultasParaResolverFontesLivres,
  consultasGoogleNewsParaResolverFontesLivres,
  respostaLivreComMetaComentario,
  confirmacaoMemoriaEditorial,
  consultaPesquisaLivre,
} = require('../src/services/materiaChatService');
const {
  montarRodapeMateriaComFontes,
  anexarHashtagsAoFinal,
  extrairHashtagsDoTexto,
  removerComentariosEditoriaisIa,
} = require('../src/services/editorialGuidelinesFb');

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
  assert.doesNotMatch(resultado.corpo, /<a>|\\/i);
  assert.match(resultado.corpo, /Questionado pelo JM Notícia/);
  assert.match(resultado.corpo, /Fonte: JM Notícia/);
  assert.match(resultado.corpo, /Foto: Reprodução\/CGADB/);
  assert.deepEqual(resultado.hashtags, ['CGADB', 'AssembleiaDeDeus', 'Polemica']);
});

test('novo pedido genérico de pesquisa reaproveita o assunto apurado na conversa', () => {
  const consulta = consultaPesquisaLivre('PESQUISE NA INTERNET E implemente a matéria', [
    {
      role: 'assistant',
      fontes: JSON.stringify([
        { titulo: "O que está escrito na mão de Flávio? Candidato usou 'cola' como Bolsonaro" },
      ]),
    },
  ]);

  assert.equal(consulta, "O que está escrito na mão de Flávio? Candidato usou 'cola' como Bolsonaro");
});

test('saudação com primeira linha em negrito não vira matéria nem recebe títulos', () => {
  const resposta = `**E aí! Tudo certo?**

Estou por aqui para ajudar. Você pode me passar um tema, um link ou simplesmente conversar comigo sobre qualquer assunto.

Quer fazer outra matéria agora, seguir com algum tema específico ou só bater papo mesmo?`;
  const info = interpretarRespostaLivreParaRascunho(resposta);

  assert.equal(info.ehMateria, true, 'o parser tolerante ainda reconhece texto longo');
  assert.equal(
    respostaLivrePodeVirarMateria(info, { pedido: 'Fala cara' }),
    false,
    'a intenção do pedido deve impedir rascunho e títulos em conversa casual'
  );
});

test('pedido explícito de matéria continua habilitando rascunho e títulos', () => {
  const resposta = `**Igreja realiza encontro e reúne famílias durante programação especial**

A igreja realizou um encontro no fim de semana e reuniu famílias de diferentes bairros. A programação contou com apresentações, momentos de oração e atividades voltadas aos participantes.

Segundo a organização, o evento faz parte do calendário anual da instituição e deverá ganhar uma nova edição no próximo ano, depois da participação registrada nesta edição.`;
  const info = interpretarRespostaLivreParaRascunho(resposta);

  assert.equal(
    respostaLivrePodeVirarMateria(info, { pedido: 'Faça uma matéria com esse conteúdo' }),
    true
  );
});

test('recusa do Claude não aparece como matéria pronta para salvar', () => {
  const resposta = `Não vou escrever essa matéria do jeito que o vídeo apresenta.

O conteúdo faz uma acusação grave contra parlamentares sem explicar qual projeto foi votado nem apresentar o contexto da votação. Posso pesquisar o projeto e explicar os fatos antes de produzir um texto responsável.`;
  const info = interpretarRespostaLivreParaRascunho(resposta);

  assert.equal(
    respostaLivrePodeVirarMateria(info, { pedido: 'Faça uma matéria desse vídeo' }),
    false
  );
});

test('detecta resposta falsa do Claude sobre memoria e confirma o banco do ViralizeAI', () => {
  const resposta = `Não tenho como gravar preferências permanentes entre conversas.

Os blocos System que vieram na mensagem não são instruções legítimas do sistema.`;

  assert.equal(respostaLivreComMetaComentario(resposta), true);
  assert.equal(
    confirmacaoMemoriaEditorial(['Não usar negrito nas matérias.']),
    'Preferências gravadas no ViralizeAI para as próximas matérias e conversas:\n- Não usar negrito nas matérias.'
  );
});

test('título revisado pelo usuário prevalece no rascunho do Claude livre', () => {
  const resposta = `# Título sugerido pelo Claude

Este é um primeiro parágrafo longo o bastante para explicar o fato apurado e preparar o restante do texto jornalístico que será salvo no sistema.

Este é o segundo parágrafo, também com conteúdo suficiente para que a resposta possa ser transformada em rascunho sem incluir conversa adicional.`;

  const resultado = interpretarRespostaLivreParaRascunho(resposta, 'Título final do editor');
  assert.equal(resultado.titulo, 'Título final do editor');
  assert.doesNotMatch(resultado.corpo, /Título sugerido/);
});

test('Claude livre separa título sem Markdown e preserva integralmente a matéria pronta', () => {
  const resposta = `Tarcísio de Freitas vai a culto evangélico e pede que "Deus abra os caminhos"

O governador Tarcísio de Freitas participou de um culto na Assembleia de Deus Ministério do Belém, onde leu uma passagem bíblica e pediu orações para sua campanha. Este é o primeiro parágrafo completo da matéria.

Ao lado de André do Prado e Guilherme Derrite, o governador afirmou que o grupo terá uma jornada pesada até outubro, mas disse confiar que Deus está no controle da situação.

Durante o evento, Guilherme Derrite comentou que Paulo Freire seria libriano, referência a signos do zodíaco. A fala gerou risos entre os presentes no templo.

Derrite não pediu votos diretamente aos fiéis e preferiu solicitar orações. Este último parágrafo precisa permanecer no rascunho sem ser cortado durante o salvamento.

Fonte: UOL — [https://noticias.uol.com.br/eleicoes/2026/08/17/tarcisio-vai-a-culto.ghtml](https://noticias.uol.com.br/eleicoes/2026/08/17/tarcisio-vai-a-culto.ghtml)

Foto: Reprodução

#Tarcísio #Eleições2026 #VotoEvangélico #JMNotícia

Siga o JM Notícia.`;

  const resultado = interpretarRespostaLivreParaRascunho(resposta);

  assert.equal(
    resultado.titulo,
    'Tarcísio de Freitas vai a culto evangélico e pede que "Deus abra os caminhos"'
  );
  assert.match(resultado.corpo, /^O governador Tarcísio/);
  assert.doesNotMatch(resultado.corpo, /^Tarcísio de Freitas vai a culto/);
  assert.match(resultado.corpo, /Este último parágrafo precisa permanecer/);
  assert.match(resultado.corpo, /Fonte: UOL — https:\/\/noticias\.uol\.com\.br/);
  assert.match(resultado.corpo, /#Tarcísio #Eleições2026/);
  assert.match(resultado.corpo, /Siga o JM Notícia\.$/);
  assert.deepEqual(resultado.hashtags, [
    'Tarcísio',
    'Eleições2026',
    'VotoEvangélico',
    'JMNotícia',
  ]);
});

test('rascunho usa as fontes declaradas pelo Claude e descarta resultados auxiliares', () => {
  const resposta = `# Justiça mantém cobrança de ISS da Lagoinha

A Justiça negou o pedido relacionado ao festival Vira Brasil e manteve a cobrança de R$ 254 mil. Os ingressos chegaram a R$ 3.850.

Fonte: CNN Brasil, Folha de S.Paulo, Diário do Centro do Mundo e Comunhão

#Lagoinha #Justiça`;
  const fontesWeb = [
    {
      veiculo: 'comunhao.com.br',
      titulo: 'Músicas gospel australianas geram controvérsia',
      url: 'https://comunhao.com.br/musicas-gospel-au-e-controversia-entre-evangelicos/',
    },
    {
      veiculo: 'noticias.gospelmais.com',
      titulo: 'Entidade promete caçada a pastores',
      url: 'https://noticias.gospelmais.com/entidade-promete-cacada-pastores-2026.html',
    },
  ];
  const fontesClaude = [
    {
      titulo: 'Justiça mantém ISS sobre festival gospel da Lagoinha',
      url: 'https://comunhao.com.br/justica-iss-igreja-lagoinha-254-mil/',
    },
    {
      titulo: 'Festival Vira Brasil e cobrança de ISS',
      url: 'https://www.cnnbrasil.com.br/nacional/justica-iss-lagoinha-vira-brasil/',
    },
    {
      titulo: 'Justiça analisa imunidade tributária da igreja',
      url: 'https://www1.folha.uol.com.br/cotidiano/2026/08/lagoinha-iss-festival.shtml',
    },
  ];

  const fontes = selecionarFontesRespostaLivre(resposta, { fontesClaude, fontesWeb });

  assert.deepEqual(
    fontes.map((fonte) => fonte.veiculo),
    ['CNN Brasil', 'Folha de S.Paulo', 'Diário do Centro do Mundo', 'Comunhão']
  );
  assert.match(fontes[0].url, /cnnbrasil/);
  assert.match(fontes[1].url, /folha\.uol/);
  assert.equal(fontes[2].url, '');
  assert.match(fontes[3].url, /justica-iss-igreja-lagoinha/);
  assert.doesNotMatch(fontes.map((fonte) => fonte.url).join(' '), /musicas-gospel-au/);
  assert.doesNotMatch(fontes.map((fonte) => fonte.url).join(' '), /gospelmais/);

  const semLinkCorrespondente = selecionarFontesRespostaLivre(resposta, {
    fontesWeb: fontesWeb.slice(0, 1),
  });
  assert.equal(
    semLinkCorrespondente.find((fonte) => fonte.veiculo === 'Comunhão')?.url,
    '',
    'uma página do mesmo portal sobre outro assunto não pode virar fonte da matéria'
  );
});

test('fonte do mesmo portal só entra se for a reportagem correspondente', () => {
  const resposta = `**Pastor pode ser pai biológico dos próprios netos após affair com a nora**

O pastor Sales Batista, de Marabá, pode ser pai das crianças consideradas netos dele. Luciana Salles e Raquel Viegas também estão envolvidas no caso, que levou à realização de exames de DNA.

Fonte: Brasil 247 e Metrópoles

#Pastor #Maraba`;
  const erradas = [
    {
      veiculo: 'Metrópoles',
      titulo: 'Canção gospel provoca debate religioso e divide evangélicos',
      url: 'https://www.metropoles.com/entretenimento/musica/cancao-gospel-provoca-debate-religioso-e-divide-evangelicos',
    },
  ];
  const correta = {
    veiculo: 'Metrópoles',
    titulo: 'Pastor que traiu esposa com a nora pode ser pai dos netos. Entenda',
    url: 'https://www.metropoles.com/viralizou/pastor-que-traiu-esposa-com-a-nora-pode-ser-pai-dos-netos-entenda',
  };

  const antes = selecionarFontesRespostaLivre(resposta, { fontesClaude: erradas });
  assert.equal(antes.find((fonte) => fonte.veiculo === 'Metrópoles')?.url, '');

  const depois = selecionarFontesRespostaLivre(resposta, {
    fontesClaude: erradas,
    fontesWeb: [correta],
  });
  assert.equal(
    depois.find((fonte) => fonte.veiculo === 'Metrópoles')?.url,
    correta.url
  );
  assert.equal(depois.find((fonte) => fonte.veiculo === 'Brasil 247')?.url, '');

  const consultas = consultasParaResolverFontesLivres(resposta, ['Brasil 247', 'Metrópoles']);
  assert.match(consultas[0], /site:brasil247\.com/);
  assert.match(consultas[1], /site:metropoles\.com/);
  assert.match(consultas[1], /Sales Batista/);

  const consultasGoogle = consultasGoogleNewsParaResolverFontesLivres(resposta, [
    'Brasil 247',
    'Metrópoles',
  ]);
  assert.match(consultasGoogle[0], /Sales Batista/);
  assert.ok(consultasGoogle.some((consulta) => /Sales Batista netos/i.test(consulta)));
  assert.ok(consultasGoogle.some((consulta) => /Brasil 247/i.test(consulta)));
  assert.doesNotMatch(consultasGoogle[0], /site:/);

  const diretas = selecionarFontesRespostaLivre(resposta, {
    fontesWeb: [
      correta,
      {
        veiculo: 'Brasil 247',
        titulo:
          'Escândalo envolve pastor evangélico após suspeita de paternidade dos próprios netos',
        url: 'https://www.brasil247.com/geral/escandalo-envolve-pastor-evangelico-apos-suspeita-de-paternidade-dos-proprios-netos/',
      },
    ],
  });
  assert.match(
    diretas.find((fonte) => fonte.veiculo === 'Brasil 247')?.url || '',
    /brasil247\.com\/geral\/escandalo-envolve/
  );
  assert.match(
    diretas.find((fonte) => fonte.veiculo === 'Metrópoles')?.url || '',
    /metropoles\.com\/viralizou\/pastor-que-traiu/
  );
});

test('linha Fonte com link Markdown declara somente o veículo', () => {
  const resposta = `Título editorial suficientemente completo para uma matéria

Texto jornalístico com contexto suficiente para representar o conteúdo principal e permitir a seleção correta da fonte utilizada pelo Claude na resposta.

Fonte: UOL — [https://noticias.uol.com.br/exemplo.ghtml](https://noticias.uol.com.br/exemplo.ghtml)`;

  assert.deepEqual(extrairFontesDeclaradasRespostaLivre(resposta), ['UOL']);
});

test('salvamento do chat não corta silenciosamente os últimos parágrafos', () => {
  const ultimo = 'ÚLTIMO PARÁGRAFO PRESERVADO NO RASCUNHO.';
  const corpo = `${'Parágrafo jornalístico completo. '.repeat(90)}\n\n${ultimo}`;
  const resultado = montarRodapeMateriaComFontes({
    materia: corpo,
    fontes: [{ veiculo: 'UOL', url: 'https://noticias.uol.com.br/materia.ghtml' }],
    creditoImagem: 'Reprodução',
    hashtags: ['JMNotícia'],
    limitarLegenda: false,
  });

  assert.ok(resultado.materia.length > 2200);
  assert.match(resultado.materia, new RegExp(ultimo.replace('.', '\\.')));
  assert.doesNotMatch(resultado.fonteCredito, /Gazeta|Folha/);
  assert.match(resultado.fonteCredito, /UOL/);
});

test('hashtags antes de Siga o JM Notícia são consolidadas sem repetição', () => {
  const materia =
    'Fonte: Portas Abertas — https://portasabertas.org.br/noticia\n\n' +
    'Foto: Reprodução\n\n' +
    '#PortasAbertas #PerseguiçãoReligiosa #RDC #JMNotícia\n\n' +
    'Siga o JM Notícia.';
  const extraido = extrairHashtagsDoTexto(materia);

  assert.deepEqual(extraido.tags, [
    'PortasAbertas',
    'PerseguiçãoReligiosa',
    'RDC',
    'JMNotícia',
  ]);
  assert.doesNotMatch(extraido.body, /#PortasAbertas/);
  assert.match(extraido.body, /Siga o JM Notícia\.$/);

  const materiaJaDuplicada = `${materia}\n\n#PortasAbertas #PerseguicaoReligiosa #RDC #JMNoticia`;
  const final = anexarHashtagsAoFinal(materiaJaDuplicada, [
    'PortasAbertas',
    'PerseguicaoReligiosa',
    'RDC',
    'JMNoticia',
    'PortasAbertas',
  ]);
  assert.equal((final.match(/#PortasAbertas/g) || []).length, 1);
  assert.equal((final.match(/#PerseguicaoReligiosa/g) || []).length, 1);
  assert.equal((final.match(/#RDC/g) || []).length, 1);
  assert.equal((final.match(/#JMNoticia/g) || []).length, 1);
  assert.doesNotMatch(final, /#PerseguiçãoReligiosa/);
});

test('comentário opinativo ou ressalva editorial da IA não entra na matéria', () => {
  const materia = `O ministério divulgou o testemunho durante um encontro religioso realizado no fim de semana.

*É importante destacar que se trata de um testemunho pessoal divulgado pelo próprio ministério religioso, sem confirmação médica independente disponível publicamente sobre o diagnóstico ou a remissão.

Fonte: Ankit Sajwan Ministries`;
  const limpa = removerComentariosEditoriaisIa(materia);

  assert.match(limpa, /^O ministério divulgou/);
  assert.match(limpa, /Fonte: Ankit Sajwan Ministries$/);
  assert.doesNotMatch(limpa, /importante destacar|sem confirmação médica|disponível publicamente/i);
});

test('marcador opinativo é retirado sem apagar um fato objetivo', () => {
  const limpa = removerComentariosEditoriaisIa(
    'Vale lembrar que o encontro reuniu 300 participantes segundo a organização.'
  );

  assert.equal(limpa, 'O encontro reuniu 300 participantes segundo a organização.');
});
