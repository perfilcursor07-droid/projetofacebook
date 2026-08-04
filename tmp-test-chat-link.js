/* eslint-disable no-console */
require('dotenv').config();

const URL_TESTE = process.argv[2] || 'https://www.bbc.com/news/articles/cn8nvg7zllxo';

(async () => {
  const db = require('./src/config/db');
  const chatService = require('./src/services/materiaChatService');

  const user = await db('users').select('id', 'email').first();
  if (!user) {
    console.log('sem usuario no banco');
    process.exit(1);
  }
  console.log('user:', user.id, user.email);

  let texto = '';
  await chatService.responder({
    userId: user.id,
    chatId: null,
    texto: URL_TESTE,
    pesquisarWeb: false,
    tom: 'natural',
    modo: 'escrever',
    onEvent: (ev) => {
      if (ev.tipo === 'passo') console.log(`[passo:${ev.passo?.kind}] ${ev.passo?.texto}`);
      else if (ev.tipo === 'delta') texto += ev.texto;
      else if (ev.tipo === 'fim') {
        console.log('\n[fim] ehMateria:', ev.mensagem?.eh_materia, '| fontes:', (ev.mensagem?.fontes || []).map((f) => f.veiculo).join(', '));
      } else if (ev.tipo === 'erro') console.log('[erro]', ev.erro);
      else console.log('[' + ev.tipo + ']');
    },
  });

  console.log('\n===== RESPOSTA =====\n');
  console.log(texto);
  console.log('\n===== FIM =====');
  await db.destroy();
})().catch((e) => {
  console.error('FALHOU:', e);
  process.exit(1);
});
