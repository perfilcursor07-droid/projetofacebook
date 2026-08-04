/* eslint-disable no-console */
// Confere a nova regra: link colado => sem pesquisa web, a menos que o editor peça.
const chatService = require('./src/services/materiaChatService');

const RX_CONTEXTO =
  /\b(pesquis|busqu|busque|procur|mais informa|mais dados|contexto|complement|atualiz|repercuss|apure|apurar|cruz)/i;

const casos = [
  'https://www.bbc.com/news/articles/cn8nvg7zllxo',
  'faça uma materia https://www.bbc.com/news/articles/cn8nvg7zllxo',
  'reescreva sem plagiar https://www.bbc.com/news/articles/cn8nvg7zllxo',
  'faça a materia e pesquise mais informações https://www.bbc.com/news/articles/cn8nvg7zllxo',
  'complemente com contexto https://www.bbc.com/news/articles/cn8nvg7zllxo',
];

for (const pedido of casos) {
  const urls = chatService.extrairUrlsDoTexto(pedido);
  const resto = urls
    .reduce((t, u) => t.replace(u, ' '), pedido)
    .replace(/\s+/g, ' ')
    .trim();
  console.log(
    JSON.stringify({
      pedido,
      resto,
      pesquisaWeb: RX_CONTEXTO.test(resto),
      pulaChecagem: resto.length < 40,
    })
  );
}
