const axios = require('axios');
const { env } = require('../config/env');

/**
 * Adaptador OpenAI-compatible para o token-free-gateway.
 *
 * O gateway fica no mesmo servidor do ViralizeAI e fala com a sessão do
 * Claude aberta no Chrome via CDP. Nenhum cookie ou login sai deste processo.
 */
function configuracao() {
  const cfg = env.tokenFreeGateway || {};
  return {
    baseUrl: String(cfg.baseUrl || 'http://127.0.0.1:3456/v1').replace(/\/+$/, ''),
    apiKey: String(cfg.apiKey || '').trim(),
    model: String(cfg.claudeModel || 'claude-sonnet-4-6').trim(),
    timeoutMs: Math.max(15_000, Number(cfg.timeoutMs) || 300_000),
  };
}

function isConfigured() {
  const cfg = configuracao();
  return Boolean(cfg.baseUrl && cfg.model);
}

function assertConfigured() {
  if (isConfigured()) return;
  const err = new Error('Token-Free Gateway não configurado. Defina TFG_BASE_URL e TFG_CLAUDE_MODEL.');
  err.status = 500;
  throw err;
}

function headers() {
  const cfg = configuracao();
  // O gateway aceita qualquer Bearer quando TFG_API_KEY está desligada. Quando
  // ele estiver configurado, esta variável precisa ser a mesma chave do gateway.
  return {
    Authorization: `Bearer ${cfg.apiKey || 'local-token-free-gateway'}`,
    'Content-Type': 'application/json',
  };
}

function mensagemDeErro(err) {
  const status = Number(err?.response?.status || err?.status || 0);
  const remoto =
    err?.response?.data?.error?.message ||
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    '';
  const detalhe = String(remoto).replace(/\s+/g, ' ').trim().slice(0, 350);
  if (status === 401 || status === 403) {
    return 'Token-Free Gateway recusou a autenticação. Confira TFG_API_KEY e execute token-free-gateway webauth novamente.';
  }
  if (status === 404) {
    return `Modelo ${configuracao().model} não está disponível no Token-Free Gateway. Rode curl http://127.0.0.1:3456/v1/models e ajuste TFG_CLAUDE_MODEL.`;
  }
  if (status === 504 || err?.code === 'ECONNABORTED') {
    return 'Token-Free Gateway demorou demais para responder. Confira a sessão do Claude e aumente TFG_TIMEOUT_MS se necessário.';
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'].includes(String(err?.code || '').toUpperCase())) {
    return 'Token-Free Gateway não está acessível. Inicie-o com token-free-gateway start e confira http://127.0.0.1:3456/health.';
  }
  return `Token-Free Gateway falhou${status ? ` (${status})` : ''}${detalhe ? `: ${detalhe}` : ''}`;
}

function normalizarMensagens(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.content != null)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: typeof m.content === 'string' ? m.content : String(m.content),
    }))
    .filter((m) => m.content.trim());
}

function montarBody(messages, { temperature = 0.7, stream = false, maxTokens = null } = {}) {
  const cfg = configuracao();
  const body = {
    model: cfg.model,
    messages: normalizarMensagens(messages),
    stream: Boolean(stream),
  };
  if (Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  if (maxTokens != null && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
  return body;
}

function extrairTexto(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((parte) => (typeof parte === 'string' ? parte : parte?.text || ''))
      .join('');
  }
  return conteudo?.text || '';
}

function criarErroGateway(err) {
  const erro = new Error(mensagemDeErro(err));
  erro.status = Number(err?.response?.status || err?.status || 502) || 502;
  erro.cause = err;
  return erro;
}

async function chatCompletion(messages, { temperature = 0.7, maxTokens = null } = {}) {
  assertConfigured();
  const cfg = configuracao();
  const body = montarBody(messages, { temperature, maxTokens, stream: false });
  if (!body.messages.length) {
    const err = new Error('Nenhuma mensagem para enviar ao Token-Free Gateway.');
    err.status = 400;
    throw err;
  }

  const inicio = Date.now();
  try {
    const { data } = await axios.post(`${cfg.baseUrl}/chat/completions`, body, {
      headers: headers(),
      timeout: cfg.timeoutMs,
    });
    const texto = extrairTexto(data?.choices?.[0]?.message?.content).trim();
    if (!texto) {
      const err = new Error('Token-Free Gateway retornou resposta vazia.');
      err.status = 502;
      throw err;
    }
    console.info(
      `[token-free-gateway] ${cfg.model} ${((Date.now() - inicio) / 1000).toFixed(1)}s tokens=${data?.usage?.total_tokens || '?'}`
    );
    return texto;
  } catch (err) {
    if (err?.status) throw err;
    throw criarErroGateway(err);
  }
}

/** Lê o SSE OpenAI do gateway e devolve a resposta completa. */
async function chatCompletionStream(messages, { temperature = 0.7, onDelta = null, timeout = null } = {}) {
  assertConfigured();
  const cfg = configuracao();
  const body = montarBody(messages, { temperature, stream: true });
  if (!body.messages.length) {
    const err = new Error('Nenhuma mensagem para enviar ao Token-Free Gateway.');
    err.status = 400;
    throw err;
  }

  let textoCompleto = '';
  try {
    const resposta = await axios.post(`${cfg.baseUrl}/chat/completions`, body, {
      headers: { ...headers(), Accept: 'text/event-stream' },
      timeout: Math.max(cfg.timeoutMs, Number(timeout) || 0),
      responseType: 'stream',
    });

    await new Promise((resolve, reject) => {
      let buffer = '';
      resposta.data.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const linhas = buffer.split('\n');
        buffer = linhas.pop() || '';
        for (const linha of linhas) {
          const valor = linha.trim();
          if (!valor.startsWith('data:')) continue;
          const payload = valor.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evento = JSON.parse(payload);
            const delta = extrairTexto(evento?.choices?.[0]?.delta?.content);
            if (!delta) continue;
            textoCompleto += delta;
            if (typeof onDelta === 'function') onDelta(delta);
          } catch {
            // Um evento SSE incompleto é ignorado; o próximo chunk completa a resposta.
          }
        }
      });
      resposta.data.on('end', resolve);
      resposta.data.on('error', reject);
    });
  } catch (err) {
    // Se já houve saída parcial, repetir a requisição poderia duplicar uma matéria.
    if (textoCompleto.trim()) throw criarErroGateway(err);
    console.warn('[token-free-gateway] stream falhou; tentando resposta normal:', err.message);
  }

  if (textoCompleto.trim()) return textoCompleto.trim();
  return chatCompletion(messages, { temperature });
}

module.exports = {
  isConfigured,
  assertConfigured,
  chatCompletion,
  chatCompletionStream,
};
