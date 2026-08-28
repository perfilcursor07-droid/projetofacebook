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

