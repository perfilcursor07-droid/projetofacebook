const Anthropic = require('@anthropic-ai/sdk');
const { env } = require('../config/env');

/**
 * Adaptador Claude (Anthropic) com a mesma assinatura do chatCompletion da
 * DeepSeek, para o resto do sistema trocar de provedor sem reescrever prompt.
 *
 * Economia de token — as quatro decisões que seguram o custo:
 *  1. Cache de prompt: o bloco fixo do system (regras editoriais + estilo
 *     aprendido) é marcado com cache_control. Leitura de cache custa 10% do
 *     token de entrada, e é o mesmo texto em toda matéria.
 *  2. Dois modelos: Sonnet 5 só escreve matéria; título, hashtags, resumo e
 *     classificação vão no Haiku 4.5 (1/2 do preço de entrada, 1/2 da saída).
 *  3. Thinking desligado por padrão. Token de raciocínio é cobrado como saída
 *     ($10/MTok no Sonnet 5) e a redação não precisa dele.
 *  4. effort baixo/médio: menos preâmbulo e resposta mais direta.
 */

const PRECOS = {
  // USD por 1 milhão de tokens (entrada, escrita de cache, leitura de cache, saída)
  'claude-sonnet-5': { entrada: 2, cacheWrite: 2.5, cacheRead: 0.2, saida: 10 },
  'claude-haiku-4-5': { entrada: 1, cacheWrite: 1.25, cacheRead: 0.1, saida: 5 },
  'claude-opus-5': { entrada: 5, cacheWrite: 6.25, cacheRead: 0.5, saida: 25 },
};

const MODELO_REDATOR = process.env.CLAUDE_WRITER_MODEL || env.claudeWriterModel || 'claude-sonnet-5';
const MODELO_AUXILIAR = process.env.CLAUDE_AUX_MODEL || env.claudeAuxModel || 'claude-haiku-4-5';

/** off | adaptive — raciocínio custa token de saída, então fica desligado. */
const THINKING_MODO = String(process.env.CLAUDE_THINKING || 'off').toLowerCase();
const CACHE_LIGADO = String(process.env.CLAUDE_CACHE || 'on').toLowerCase() !== 'off';

/**
 * Perfis por tipo de tarefa. `redacao` é a única que usa o modelo caro.
 */
const PERFIS = {
  redacao: { modelo: MODELO_REDATOR, effort: 'medium', maxTokens: 8000 },
  auxiliar: { modelo: MODELO_AUXILIAR, effort: 'low', maxTokens: 2000 },
  conversa: { modelo: MODELO_REDATOR, effort: 'low', maxTokens: 4000 },
};

function perfilDaTarefa(tarefa) {
  return PERFIS[tarefa] || PERFIS.auxiliar;
}

/**
 * `effort` e `thinking` só existem na geração 4.6+. Mandar num modelo antigo
 * (Haiku 4.5, por exemplo) devolve 400 "does not support the effort parameter".
 * Modelo desconhecido entra pelo caminho conservador: só o que é obrigatório.
 */
const CAPACIDADES = {
  'claude-opus-5': { effort: true, thinking: true },
  'claude-opus-4-8': { effort: true, thinking: true },
  'claude-opus-4-7': { effort: true, thinking: true },
  'claude-opus-4-6': { effort: true, thinking: true },
  'claude-sonnet-5': { effort: true, thinking: true },
  'claude-sonnet-4-6': { effort: true, thinking: true },
  'claude-haiku-4-5': { effort: false, thinking: false },
};

function capacidades(modelo) {
  return CAPACIDADES[String(modelo)] || { effort: false, thinking: false };
}

/** Monta só os parâmetros que o modelo aceita. */
function opcoesDoModelo(modelo, perfil, pensar) {
  const cap = capacidades(modelo);
  const extra = {};
  if (cap.thinking) extra.thinking = pensar ? { type: 'adaptive' } : { type: 'disabled' };
  if (cap.effort) extra.output_config = { effort: perfil.effort };
  return extra;
}

let cliente = null;

function assertClaude() {
  if (!env.anthropicApiKey) {
    const err = new Error('ANTHROPIC_API_KEY não configurada no .env');
    err.status = 500;
    throw err;
  }
}

function getCliente() {
  assertClaude();
  if (!cliente) {
    cliente = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2, timeout: 180_000 });
  }
  return cliente;
}

function isConfigured() {
  return Boolean(env.anthropicApiKey);
}

/**
 * O cache é casamento de prefixo: qualquer byte diferente no começo invalida
 * tudo depois. Por isso o system é enviado em dois blocos — o fixo (com
 * cache_control) e o variável (sorteios de tamanho/estilo de cada matéria).
 */
function montarSystem(messages) {
  const partes = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => String(m.content || '').trim())
    .filter(Boolean);
  if (!partes.length) return { system: undefined, conversa: messages };

  const conversa = messages
    .filter((m) => m && m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    }))
    .filter((m) => m.content.trim());

  // Bloco 0 = prefixo estável (cacheado). Demais blocos = variação da chamada.
  const blocos = partes.map((texto) => ({ type: 'text', text: texto }));
  if (CACHE_LIGADO) {
    blocos[0].cache_control = { type: 'ephemeral' };
  }
  return { system: blocos, conversa };
}

/** Claude devolve JSON limpo quase sempre, mas cerca em ``` de vez em quando. */
function limparJson(raw) {
  let texto = String(raw || '').trim();
  const cerca = texto.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (cerca) texto = cerca[1].trim();
  if (texto.startsWith('{') || texto.startsWith('[')) return texto;
  const inicio = texto.search(/[[{]/);
  if (inicio < 0) return texto;
  const abre = texto[inicio];
  const fecha = abre === '{' ? '}' : ']';
  const fim = texto.lastIndexOf(fecha);
  if (fim > inicio) return texto.slice(inicio, fim + 1).trim();
  return texto;
}

function textoDaResposta(message) {
  return (message?.content || [])
    .filter((bloco) => bloco.type === 'text')
    .map((bloco) => bloco.text)
    .join('')
    .trim();
}

function logarUso(modelo, inicio, usage, tarefa) {
  const p = PRECOS[modelo] || PRECOS['claude-sonnet-5'];
  const entrada = usage?.input_tokens || 0;
  const write = usage?.cache_creation_input_tokens || 0;
  const read = usage?.cache_read_input_tokens || 0;
  const saida = usage?.output_tokens || 0;
  const custo =
    (entrada * p.entrada + write * p.cacheWrite + read * p.cacheRead + saida * p.saida) / 1_000_000;
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(
    `[claude] ${modelo} ${tarefa} ${segundos}s in=${entrada} cacheW=${write} cacheR=${read} out=${saida} ~$${custo.toFixed(4)}`
  );
  return custo;
}

/**
 * Compatível com deepseekService.chatCompletion.
 * `temperature` é aceito e ignorado — Sonnet 5 recusa parâmetros de amostragem.
 */
async function chatCompletion(
  messages,
  { json = true, thinking = false, tarefa = 'auxiliar', maxTokens = null, model = null } = {}
) {
  const perfil = perfilDaTarefa(tarefa);
  const modelo = model || perfil.modelo;
  const { system, conversa } = montarSystem(messages);

  if (!conversa.length) {
    const err = new Error('Nenhuma mensagem de usuário para enviar ao Claude');
    err.status = 400;
    throw err;
  }

  const pensar = THINKING_MODO === 'adaptive' || (THINKING_MODO === 'auto' && thinking);
  const body = {
    model: modelo,
    max_tokens: Number(maxTokens || perfil.maxTokens),
    system,
    messages: conversa,
    ...opcoesDoModelo(modelo, perfil, pensar),
  };

  const inicio = Date.now();
  let resposta;
  try {
    resposta = await getCliente().messages.create(body);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      err.status = 429;
      err.message = `Claude sem cota no momento: ${err.message}`;
    } else if (err instanceof Anthropic.AuthenticationError) {
      err.status = 401;
      err.message = 'ANTHROPIC_API_KEY inválida ou revogada.';
    } else if (err instanceof Anthropic.APIError) {
      err.status = err.status || 502;
    }
    console.error(`[claude] falhou ${modelo} ${tarefa}:`, err.message);
    throw err;
  }

  logarUso(modelo, inicio, resposta.usage, tarefa);

  // Classificadores de segurança podem recusar; content vem vazio ou parcial.
  if (resposta.stop_reason === 'refusal') {
    const err = new Error(
      `Claude recusou a geração (${resposta.stop_details?.category || 'sem categoria'}). Ajuste a pauta e tente de novo.`
    );
    err.status = 422;
    throw err;
  }

  const texto = textoDaResposta(resposta);
  if (!texto) {
    const err = new Error('Claude retornou resposta vazia');
    err.status = 502;
    throw err;
  }
  return json ? limparJson(texto) : texto;
}

/** Mesma interface do chatCompletionStream da DeepSeek. */
async function chatCompletionStream(
  messages,
  { onDelta = null, thinking = false, tarefa = 'conversa', maxTokens = null, model = null } = {}
) {
  const perfil = perfilDaTarefa(tarefa);
  const modelo = model || perfil.modelo;
  const { system, conversa } = montarSystem(messages);
  const pensar = THINKING_MODO === 'adaptive' || (THINKING_MODO === 'auto' && thinking);

  const inicio = Date.now();
  try {
    const stream = getCliente().messages.stream({
      model: modelo,
      max_tokens: Number(maxTokens || perfil.maxTokens),
      system,
      messages: conversa,
      ...opcoesDoModelo(modelo, perfil, pensar),
    });

    if (typeof onDelta === 'function') {
      stream.on('text', (delta) => onDelta(delta));
    }

    const message = await stream.finalMessage();
    logarUso(modelo, inicio, message.usage, `${tarefa}/stream`);
    const texto = textoDaResposta(message);
    if (texto) return texto;
  } catch (err) {
    console.warn('[claude-stream] falhou, usando modo normal:', err.message);
  }

  // Sem stream utilizável, cai para a chamada comum (o chamador já espera isso).
  const raw = await chatCompletion(messages, { json: false, thinking, tarefa, maxTokens, model });
  if (typeof onDelta === 'function') onDelta(raw);
  return String(raw || '').trim();
}

module.exports = {
  chatCompletion,
  chatCompletionStream,
  isConfigured,
  limparJson,
  MODELO_REDATOR,
  MODELO_AUXILIAR,
};
