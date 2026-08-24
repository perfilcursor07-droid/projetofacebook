const assert = require('node:assert/strict');
const test = require('node:test');

const {
  interpretarRespostaLivreParaRascunho,
  selecionarFontesRespostaLivre,
  consultasParaResolverFontesLivres,
  consultasGoogleNewsParaResolverFontesLivres,
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
