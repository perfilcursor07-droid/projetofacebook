const test = require('node:test');
const assert = require('node:assert/strict');

const deepseekService = require('../src/services/deepseekService');
const tokenFree = require('../src/services/tokenFreeGatewayService');
const claude = require('../src/services/claudeService');

test('títulos rotulados como Claude usam o Token-Free Claude quando disponível', async () => {
  const originals = {
    cobreTarefa: tokenFree.cobreTarefa,
    tokenChat: tokenFree.chatCompletion,
    claudeConfigured: claude.isConfigured,
    claudeChat: claude.chatCompletion,
  };
  let chamadaToken = null;
  let chamouAnthropic = false;

  try {
    tokenFree.cobreTarefa = (tarefa) => tarefa === 'conversa';
    tokenFree.chatCompletion = async (_messages, options) => {
      chamadaToken = options;
      return '{"titulos":["Título A","Título B","Título C"]}';
    };
    claude.isConfigured = () => true;
    claude.chatCompletion = async () => {
      chamouAnthropic = true;
      return '{}';
    };

    const resposta = await deepseekService.chatCompletionClaudeObrigatorio(
      [{ role: 'user', content: 'Gere títulos' }],
      { json: true }
    );

    assert.match(resposta, /Título A/);
    assert.equal(chamadaToken.tarefa, 'conversa');
    assert.match(chamadaToken.conversationName, /títulos sugeridos pelo Claude/);
    assert.equal(chamouAnthropic, false);
  } finally {
    tokenFree.cobreTarefa = originals.cobreTarefa;
    tokenFree.chatCompletion = originals.tokenChat;
    claude.isConfigured = originals.claudeConfigured;
    claude.chatCompletion = originals.claudeChat;
  }
});

test('sem Token-Free, títulos usam API Claude e nunca DeepSeek', async () => {
  const originals = {
    cobreTarefa: tokenFree.cobreTarefa,
    claudeConfigured: claude.isConfigured,
    claudeChat: claude.chatCompletion,
  };
  let optionsClaude = null;

  try {
    tokenFree.cobreTarefa = () => false;
    claude.isConfigured = () => true;
    claude.chatCompletion = async (_messages, options) => {
      optionsClaude = options;
      return '{"titulo":"Título do Claude"}';
    };

    const resposta = await deepseekService.chatCompletionClaudeObrigatorio(
      [{ role: 'user', content: 'Gere um título' }],
      { json: true }
    );

    assert.match(resposta, /Título do Claude/);
    assert.equal(optionsClaude.tarefa, 'conversa');
  } finally {
    tokenFree.cobreTarefa = originals.cobreTarefa;
    claude.isConfigured = originals.claudeConfigured;
    claude.chatCompletion = originals.claudeChat;
  }
});

test('títulos alternativos enviados ao Claude respeitam o tom escolhido na conversa', async () => {
  const originals = {
    cobreTarefa: tokenFree.cobreTarefa,
    tokenChat: tokenFree.chatCompletion,
  };
  let mensagensRecebidas = null;

  try {
    tokenFree.cobreTarefa = (tarefa) => tarefa === 'conversa';
    tokenFree.chatCompletion = async (messages) => {
      mensagensRecebidas = messages;
      return JSON.stringify({
        titulos: [
          'Silas Malafaia confronta governo e acende nova disputa pública sobre liberdade religiosa',
          'Silas Malafaia eleva tensão com governo após episódio que provoca reação entre lideranças',
          'Confronto entre Silas Malafaia e governo ganha novo capítulo e amplia pressão nos bastidores',
        ],
      });
    };

    const titulos = await deepseekService.gerarTitulosAlternativos({
      titulo: 'Silas Malafaia confronta governo em debate sobre liberdade religiosa',
      materia:
        'Silas Malafaia criticou publicamente uma decisão do governo durante um debate sobre liberdade religiosa. A manifestação provocou respostas de representantes oficiais e de outras lideranças.',
      tom: 'polemico',
      tarefa: 'conversa',
    });

    const prompt = mensagensRecebidas.map((item) => item.content).join('\n');
    assert.equal(titulos.length, 3);
    assert.match(prompt, /Tom escolhido pelo usuário: polemico/i);
    assert.match(prompt, /SUSPENSE E POLÊMICA DE VERDADE/i);
  } finally {
    tokenFree.cobreTarefa = originals.cobreTarefa;
    tokenFree.chatCompletion = originals.tokenChat;
  }
});
