const test = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('../src/services/tokenFreeGatewayService');
const { nomeModeloHumano, provedorDoModelo } = require('../src/services/materiaModelosService');

const MENSAGENS = [{ role: 'user', content: 'teste' }];
const OPCOES = { json: false, tarefa: 'conversa', conversationId: 'viralizeai:user:1:chat:9' };

test('usa o modelo escolhido pelo editor só dentro da requisição', async () => {
  const dentro = await gateway.comModelo('gpt-5.6', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return gateway.bodyDaChamada(MENSAGENS, OPCOES);
  });
  const fora = gateway.bodyDaChamada(MENSAGENS, OPCOES);

  assert.equal(dentro.model, 'gpt-5.6');
  assert.equal(dentro.conversation_id, 'viralizeai:user:1:chat:9:model:gpt-5.6');
  assert.equal(fora.model, gateway.MODELO);
  assert.equal(fora.conversation_id, 'viralizeai:user:1:chat:9');
});

test('sem modelo escolhido mantém o modelo do .env', () => {
  const body = gateway.comModelo(null, () => gateway.bodyDaChamada(MENSAGENS, OPCOES));
  assert.equal(body.model, gateway.MODELO);
});

test('nomeia e classifica os modelos do Claude e do ChatGPT', () => {
  assert.equal(nomeModeloHumano('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(nomeModeloHumano('gpt-5.6'), 'ChatGPT 5.6');
  assert.equal(provedorDoModelo('gpt-5.6'), 'chatgpt');
  assert.equal(provedorDoModelo('claude-opus-5-5'), 'claude');
});
