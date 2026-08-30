const axios = require('axios');
const AiProviderSettings = require('../models/AiProviderSettings');
const credentialCipher = require('./credentialCipher');
const { env } = require('../config/env');

const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    model: () => env.tokenFreeGateway?.model || env.claudeWriterModel || 'claude-sonnet-5',
    origin: 'token-free-gateway',
  },
  openai: {
    id: 'openai',
    label: 'ChatGPT',
    model: () => env.openaiModel || 'gpt-5.4',
    origin: 'openai',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    model: () => env.deepseekWriterModel || env.deepseekModel || 'deepseek-v4-flash',
    origin: 'deepseek',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    model: () => env.xaiModel || 'grok-4.6',
    origin: 'xai',
  },
};

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!PROVIDERS[provider]) {
    const err = new Error('Provedor de IA inválido.');
    err.status = 400;
    throw err;
  }
  return provider;
}

function normalizeModel(value, provider) {
  const model = String(value || PROVIDERS[provider].model()).trim().slice(0, 120);
  if (!model) {
    const err = new Error('Informe o modelo que será usado.');
    err.status = 400;
    throw err;
  }
  return model;
}

function envApiKey(provider) {
  if (provider === 'openai') return String(env.openaiApiKey || '').trim();
  if (provider === 'deepseek') return String(env.deepseekApiKey || '').trim();
  if (provider === 'grok') return String(env.xaiApiKey || '').trim();
  return '';
}

function claudeConfigured() {
  return Boolean(
    require('./tokenFreeGatewayService').isConfigured() ||
    require('./claudeService').isConfigured()
  );
}

function decryptKey(row) {
  if (!row?.api_key_cipher) return '';
  try {
    return credentialCipher.decrypt(row.api_key_cipher);
  } catch (cause) {
    const err = new Error(
      'Não foi possível abrir a credencial salva. Confira AI_CREDENTIALS_SECRET ou cadastre a chave novamente.'
    );
    err.status = 500;
    err.cause = cause;
    throw err;
  }
}

function isConfigured(provider, row = null) {
  if (provider === 'claude') return claudeConfigured();
  return Boolean(row?.api_key_cipher || envApiKey(provider));
}

function legacyProvider() {
  const configured = String(env.aiProvider || '').toLowerCase();
  if (['claude', 'token-free', 'token_free', 'tokenfree'].includes(configured)) return 'claude';
  if (configured === 'deepseek') return 'deepseek';
  return claudeConfigured() ? 'claude' : 'deepseek';
}

function missingTable(err) {
  return ['ER_NO_SUCH_TABLE', 'SQLITE_ERROR'].includes(String(err?.code || '')) &&
    /ai_provider_settings/i.test(String(err?.message || err?.sqlMessage || ''));
}

async function rowsByProvider() {
  try {
    const rows = await AiProviderSettings.list();
    return new Map(rows.map((row) => [row.provider, row]));
  } catch (err) {
    if (missingTable(err)) return new Map();
    throw err;
  }
}

function toPublic(provider, row, selectedProvider) {
  const metadata = PROVIDERS[provider];
  const configured = isConfigured(provider, row);
  return {
    provider,
    label: metadata.label,
    model: String(row?.model || metadata.model()),
    configured,
    credentialSource:
      provider === 'claude'
        ? configured ? 'sessão/API Claude' : null
        : row?.api_key_cipher
          ? 'painel'
          : envApiKey(provider)
            ? 'ambiente'
            : null,
    selected: provider === selectedProvider,
    lastTest: row?.last_test_at
      ? {
          status: row.last_test_status || null,
          message: row.last_test_message || null,
          at: row.last_test_at,
        }
      : null,
  };
}

async function listPublic() {
  const rows = await rowsByProvider();
  const selectedRow = [...rows.values()].find((row) => Boolean(row.selected_materia_manual));
  const selectedProvider = selectedRow?.provider || legacyProvider();
  return {
    selectedProvider,
    providers: Object.keys(PROVIDERS).map((provider) =>
      toPublic(provider, rows.get(provider), selectedProvider)
    ),
  };
}

async function getSelected({ includeApiKey = true } = {}) {
  let row = null;
  try {
    row = await AiProviderSettings.findSelected();
    if (!row) row = await AiProviderSettings.findByProvider(legacyProvider());
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
  const provider = normalizeProvider(row?.provider || legacyProvider());
  return {
    provider,
    label: PROVIDERS[provider].label,
    model: normalizeModel(row?.model, provider),
    configured: isConfigured(provider, row),
    apiKey: provider === 'claude' || !includeApiKey ? '' : decryptKey(row) || envApiKey(provider),
    origin: PROVIDERS[provider].origin,
  };
}

async function save(providerValue, { apiKey, model } = {}) {
  const provider = normalizeProvider(providerValue);
  const current = await AiProviderSettings.findByProvider(provider);
  const data = { model: normalizeModel(model || current?.model, provider) };
  const normalizedKey = String(apiKey || '').trim();
  if (provider !== 'claude' && normalizedKey) {
    data.api_key_cipher = credentialCipher.encrypt(normalizedKey);
  }
  if (normalizedKey || (current && data.model !== current.model)) {
    data.last_test_status = null;
    data.last_test_message = null;
    data.last_test_at = null;
  }
  const row = await AiProviderSettings.upsert(provider, data);
  return toPublic(provider, row, Boolean(row.selected_materia_manual) ? provider : null);
}

async function select(providerValue, { model } = {}) {
  const provider = normalizeProvider(providerValue);
  const current = await AiProviderSettings.findByProvider(provider);
  const selectedModel = normalizeModel(model || current?.model, provider);
  if (!isConfigured(provider, current)) {
    const err = new Error(
      provider === 'claude'
        ? 'Autorize a sessão do Claude ou configure ANTHROPIC_API_KEY antes de selecionar.'
        : `Cadastre a chave da ${PROVIDERS[provider].label} antes de selecionar.`
    );
    err.status = 422;
    throw err;
  }
  // Não coloca um provedor quebrado em produção: o botão de seleção também
  // autentica e valida o modelo antes de trocar o roteamento.
  await test(provider, { model: selectedModel });
  await AiProviderSettings.select(provider, selectedModel);
  return listPublic();
}

async function removeKey(providerValue) {
  const provider = normalizeProvider(providerValue);
  if (provider === 'claude') {
    const err = new Error('A sessão do Claude é gerenciada pelos controles próprios da página.');
    err.status = 400;
    throw err;
  }
  const current = await AiProviderSettings.findByProvider(provider);
  const explicitlySelected = await AiProviderSettings.findSelected();
  const effectivelySelected = explicitlySelected
    ? explicitlySelected.provider === provider
    : legacyProvider() === provider;
  if (effectivelySelected && !envApiKey(provider)) {
    const err = new Error('Selecione outro provedor para o Matéria manual antes de remover esta chave.');
    err.status = 409;
    throw err;
  }
  const row = await AiProviderSettings.upsert(provider, {
    model: normalizeModel(current?.model, provider),
    api_key_cipher: null,
    last_test_status: null,
    last_test_message: null,
    last_test_at: null,
  });
  return toPublic(provider, row, Boolean(row.selected_materia_manual) ? provider : null);
}

function jsonInstruction(messages, json) {
  const list = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role,
    content: String(message.content || ''),
  }));
  if (!json) return list;
  const rule = 'Responda somente com JSON válido, sem markdown nem texto fora do JSON.';
  const system = list.find((message) => message.role === 'system');
  if (system) system.content = `${system.content}\n\n${rule}`;
  else list.unshift({ role: 'system', content: rule });
  return list;
}

function stripJsonFence(value) {
  const text = String(value || '').trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function remoteMessage(err) {
  return String(
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    'erro desconhecido'
  );
}

function normalizeRemoteError(err, provider) {
  const status = Number(err?.response?.status || err?.status || 0);
  const label = PROVIDERS[provider]?.label || 'IA';
  const detail = remoteMessage(err);
  let message = `${label}: ${detail}`;
  if (status === 401 || status === 403) message = `${label}: chave inválida ou sem permissão.`;
  if (status === 429) message = `${label}: limite ou saldo da API atingido.`;
  const normalized = new Error(message);
  normalized.status = status >= 400 && status < 500 ? status : 502;
  normalized.cause = err;
  return normalized;
}

function extractResponseText(data) {
  if (data?.output_text) return String(data.output_text).trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('').trim();
}

async function callOpenAI(config, messages, { json = false, timeout = 180_000 } = {}) {
  const prepared = jsonInstruction(messages, json);
  const instructions = prepared
    .filter((message) => ['system', 'developer'].includes(message.role))
    .map((message) => message.content)
    .join('\n\n');
  const input = prepared
    .filter((message) => !['system', 'developer'].includes(message.role))
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: config.model,
        input,
        ...(instructions ? { instructions } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout,
      }
    );
    const text = extractResponseText(data);
    if (!text) throw new Error('resposta vazia');
    return json ? stripJsonFence(text) : text;
  } catch (err) {
    throw normalizeRemoteError(err, 'openai');
  }
}

async function callOpenAICompatible(
  config,
  messages,
  { json = false, temperature = 0.7, timeout = 180_000 } = {}
) {
  const provider = config.provider;
  const url = provider === 'grok'
    ? 'https://api.x.ai/v1/chat/completions'
    : 'https://api.deepseek.com/chat/completions';
  const body = {
    model: config.model,
    messages: jsonInstruction(messages, json),
    temperature,
    stream: false,
    ...(provider === 'deepseek' && json ? { response_format: { type: 'json_object' } } : {}),
  };
  if (provider === 'deepseek' && config.model.includes('v4')) {
    body.thinking = { type: 'disabled' };
  }
  try {
    const { data } = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout,
    });
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('resposta vazia');
    return json ? stripJsonFence(text) : text;
  } catch (err) {
    throw normalizeRemoteError(err, provider);
  }
}

async function readSse(response, getDelta, onDelta) {
  let full = '';
  await new Promise((resolve, reject) => {
    let buffer = '';
    const processLine = (line) => {
      const text = String(line || '').trim();
      if (!text.startsWith('data:')) return;
      const payload = text.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const event = JSON.parse(payload);
        if (event?.error?.message) return reject(new Error(event.error.message));
        const delta = String(getDelta(event) || '');
        if (delta) {
          full += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) reject(err);
      }
    };
    response.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    });
    response.data.on('end', () => {
      if (buffer.trim()) processLine(buffer);
      resolve();
    });
    response.data.on('error', reject);
  });
  return full.trim();
}

async function streamOpenAI(config, messages, { onDelta, timeout = 180_000 } = {}) {
  const prepared = jsonInstruction(messages, false);
  const instructions = prepared
    .filter((message) => ['system', 'developer'].includes(message.role))
    .map((message) => message.content)
    .join('\n\n');
  const input = prepared
    .filter((message) => !['system', 'developer'].includes(message.role))
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/responses',
      {
        model: config.model,
        input,
        stream: true,
        ...(instructions ? { instructions } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        responseType: 'stream',
        timeout,
      }
    );
    const text = await readSse(
      response,
      (event) => event?.type === 'response.output_text.delta' ? event.delta : '',
      onDelta
    );
    if (!text) throw new Error('resposta vazia');
    return text;
  } catch (err) {
    throw normalizeRemoteError(err, 'openai');
  }
}

async function streamOpenAICompatible(
  config,
  messages,
  { onDelta, temperature = 0.7, timeout = 180_000 } = {}
) {
  const provider = config.provider;
  const url = provider === 'grok'
    ? 'https://api.x.ai/v1/chat/completions'
    : 'https://api.deepseek.com/chat/completions';
  const body = {
    model: config.model,
    messages: jsonInstruction(messages, false),
    temperature,
    stream: true,
  };
  if (provider === 'deepseek' && config.model.includes('v4')) {
    body.thinking = { type: 'disabled' };
  }
  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      responseType: 'stream',
      timeout,
    });
    const text = await readSse(
      response,
      (event) => event?.choices?.[0]?.delta?.content || '',
      onDelta
    );
    if (!text) throw new Error('resposta vazia');
    return text;
  } catch (err) {
    throw normalizeRemoteError(err, provider);
  }
}

async function callClaude(config, messages, options = {}) {
  const tokenFree = require('./tokenFreeGatewayService');
  if (tokenFree.isConfigured()) {
    return tokenFree.chatCompletion(messages, {
      ...options,
      tarefa: 'conversa',
      model: config.model,
      conversationName: options.conversationName || 'ViralizeAI — Matéria manual',
    });
  }
  const claude = require('./claudeService');
  if (claude.isConfigured()) {
    return claude.chatCompletion(messages, {
      ...options,
      tarefa: options.tarefa || 'conversa',
      model: config.model,
    });
  }
  const err = new Error('Claude não está autorizado. Abra /claude e conecte a conta.');
  err.status = 503;
  throw err;
}

async function complete(config, messages, options = {}) {
  if (!config?.configured) {
    const err = new Error(`Configure ${config?.label || 'o provedor'} antes de usar no Matéria manual.`);
    err.status = 503;
    throw err;
  }
  if (config.provider === 'claude') return callClaude(config, messages, options);
  if (!config.apiKey) {
    const err = new Error(`A chave da ${config.label} não está configurada.`);
    err.status = 503;
    throw err;
  }
  if (config.provider === 'openai') return callOpenAI(config, messages, options);
  return callOpenAICompatible(config, messages, options);
}

async function completeStream(config, messages, options = {}) {
  if (!config?.configured) return complete(config, messages, options);
  if (config.provider === 'claude') {
    const tokenFree = require('./tokenFreeGatewayService');
    if (tokenFree.isConfigured()) {
      return tokenFree.chatCompletionStream(messages, {
        ...options,
        tarefa: 'conversa',
        model: config.model,
        conversationName: options.conversationName || 'ViralizeAI — Matéria manual',
      });
    }
    const claude = require('./claudeService');
    if (claude.isConfigured()) {
      return claude.chatCompletionStream(messages, {
        ...options,
        tarefa: options.tarefa || 'conversa',
        model: config.model,
      });
    }
    return complete(config, messages, options);
  }
  if (!config.apiKey) return complete(config, messages, options);
  if (config.provider === 'openai') return streamOpenAI(config, messages, options);
  return streamOpenAICompatible(config, messages, options);
}

async function test(providerValue, { apiKey, model } = {}) {
  const provider = normalizeProvider(providerValue);
  const row = await AiProviderSettings.findByProvider(provider);
  const config = {
    provider,
    label: PROVIDERS[provider].label,
    model: normalizeModel(model || row?.model, provider),
    configured: provider === 'claude'
      ? claudeConfigured()
      : Boolean(String(apiKey || '').trim() || row?.api_key_cipher || envApiKey(provider)),
    apiKey: provider === 'claude'
      ? ''
      : String(apiKey || '').trim() || decryptKey(row) || envApiKey(provider),
  };
  let status = 'success';
  let message = 'Conexão validada com sucesso.';
  try {
    const response = await complete(
      config,
      [{ role: 'user', content: 'Responda apenas: conexão ok' }],
      { json: false, timeout: 45_000, tarefa: 'conversa' }
    );
    if (!String(response || '').trim()) throw new Error('resposta vazia');
  } catch (err) {
    status = 'error';
    message = err.message;
  }
  await AiProviderSettings.upsert(provider, {
    model: config.model,
    last_test_status: status,
    last_test_message: String(message).slice(0, 500),
    last_test_at: new Date(),
  });
  if (status === 'error') {
    const err = new Error(message);
    err.status = 422;
    throw err;
  }
  return { ok: true, provider, model: config.model, message };
}

function humanModelName(model, provider) {
  const value = String(model || '').trim();
  const lower = value.toLowerCase();
  if (lower.includes('claude-sonnet-5')) return 'Sonnet 5';
  if (lower.includes('claude-sonnet')) return 'Sonnet';
  if (lower.includes('claude-haiku')) return 'Haiku';
  if (lower.includes('claude-opus')) return 'Opus';
  if (provider === 'openai') return value.toUpperCase().replace(/^GPT-/, 'GPT-');
  if (provider === 'deepseek' && lower.includes('v4')) return 'DeepSeek V4';
  if (provider === 'grok') return value.replace(/^grok-/i, 'Grok ').replace(/-/g, ' ');
  return value.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describe(config) {
  const provider = normalizeProvider(config.provider);
  const model = normalizeModel(config.model, provider);
  return {
    provider,
    modelo: model,
    nome: humanModelName(model, provider),
    nivel: provider === 'claude' ? 'Médio' : model.toLowerCase().includes('flash') ? 'Flash' : '',
    origem: config.origin || PROVIDERS[provider].origin,
    provedorNome: PROVIDERS[provider].label,
  };
}

module.exports = {
  PROVIDERS,
  listPublic,
  getSelected,
  save,
  select,
  removeKey,
  test,
  complete,
  completeStream,
  describe,
  normalizeProvider,
  stripJsonFence,
  extractResponseText,
};
