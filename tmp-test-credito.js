/* eslint-disable no-console */
const chatService = require('./src/services/materiaChatService');

const fontes = [
  { veiculo: 'BBC News', url: 'https://www.bbc.com/news/articles/cn8nvg7zllxo', fonteColada: true },
];

const semCredito = [
  'Missionária escocesa é achada morta dentro de mala na Grécia',
  '',
  'Lisa Ross, de 38 anos, foi encontrada morta dentro de uma mala em um prédio abandonado em Atenas, no dia 18 de julho, dias após ser dada como desaparecida.',
  '',
  'O pastor Peter Anderson prestou homenagem à missionária, que era membro da congregação há 20 anos.',
  '',
  '#Missao #Igreja',
].join('\n');

const r1 = chatService.garantirCitacaoDoVeiculo(semCredito, fontes);
console.log('inserido:', r1.inserido);
console.log(r1.texto);

const comCredito = semCredito.replace('Lisa Ross', 'Segundo a BBC News, Lisa Ross');
const r2 = chatService.garantirCitacaoDoVeiculo(comCredito, fontes);
console.log('\nja citava -> inserido:', r2.inserido, '| texto igual:', r2.texto === comCredito);

console.log('\nfonteEmOutroIdioma (pt):', chatService.fonteEmOutroIdioma([
  { fonteColada: true, trecho: 'A polícia informou que o homem foi preso e que a igreja divulgou nota. Segundo os investigadores, era uma missionária que estava desaparecida havia dias e não foi encontrada com vida. '.repeat(2) },
]));
