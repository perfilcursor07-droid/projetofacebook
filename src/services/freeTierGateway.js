const axios = require('axios');
const providerHealth = require('./providerHealth');

/**
 * Camada grátis da cascata de IA — o degrau antes da DeepSeek e do Claude.
 *
 * O custo do /materia-manual não vem da redação: vem do resto. Título,
 * hashtags, resumo, termos de imagem e classificação são chamadas curtas e
 * mecânicas, mas são MUITAS por matéria. Elas não precisam de Sonnet 5.
 *
 * Os três provedores aqui têm free tier de verdade e falam o mesmo dialeto
 * (OpenAI chat/completions), então um único cliente axios atende os três — o
 * Gemini publica um endpoint OpenAI-compatible justamente para isso.
 *
 *   FREE_TIER_PROVIDERS=gemini,groq,openrouter   ordem da cascata
 *   FREE_TIER_TAREFAS=auxiliar                   quais tarefas descem pra cá
 *
 * Chave que falta = provedor pulado, sem erro. Se todos falharem, a função
 * devolve null e o chamador segue para o caminho pago de sempre.
 */

const PROVEDORES = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    chaveEnv: 'GEMINI_API_KEY',
    modeloEnv: 'GEMINI_MODEL',
    modeloPadrao: 'gemini-2.5-flash',
    suportaJson: true,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    chaveEnv: 'GROQ_API_KEY',
    modeloEnv: 'GROQ_MODEL',
    modeloPadrao: 'llama-3.3-70b-versatile',
    suportaJson: true,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    chaveEnv: 'OPENROUTER_API_KEY',
    modeloEnv: 'OPENROUTER_MODEL',
    // Sufixo :free = sem cobrança, com rate limit menor.
    modeloPadrao: 'meta-llama/llama-3.3-70b-instruct:free',
    suportaJson: false,
  },
};

const ORDEM = String(process.env.FREE_TIER_PROVIDERS || 'gemini,groq,openrouter')
  .toLowerCase()
  .split(',')
  .map((p) => p.trim())
  .filter((p) => Object.prototype.hasOwnProperty.call(PROVEDORES, p));

/**
 * Quais tarefas descem para o tier grátis. Só 'auxiliar' por padrão: redação e
 * conversa são o produto, e nesses dois a diferença de qualidade aparece.
 */
const TAREFAS_NO_FREE_TIER = new Set(
  String(process.env.FREE_TIER_TAREFAS || 'auxiliar')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
);

function chaveDe(nome) {
  return String(process.env[PROVEDORES[nome].chaveEnv] || '').trim();
}

function modeloDe(nome) {
  const p = PROVEDORES[nome];
  return String(process.env[p.modeloEnv] || '').trim() || p.modeloPadrao;
}

/** Provedores com chave preenchida e fora da pausa do circuit breaker. */
function provedoresDisponiveis() {
  return ORDEM.filter((nome) => chaveDe(nome) && !providerHealth.estaFora(`free:${nome}`));
}

/** Tem pelo menos uma chave grátis configurada? (ignora pausa) */
function isConfigured() {
  return ORDEM.some((nome) => Boolean(chaveDe(nome)));
}

/** Esta tarefa específica deve tentar o tier grátis primeiro? */
function cobreTarefa(tarefa) {
  if (!isConfigured()) return false;
  return TAREFAS_NO_FREE_TIER.has(String(tarefa || 'auxiliar').toLowerCase());
}

/** Só para o log de diagnóstico da tela. */
function statusProvedores() {
  return ORDEM.map((nome) => ({
    provedor: nome,
    modelo: modeloDe(nome),
    temChave: Boolean(chaveDe(nome)),
    ...providerHealth.status(`free:${nome}`),
  }));
}

function mensagemDeErro(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    'erro desconhecido'
  );
}

/**
 * Rate limit do free tier é o caso normal, não a exceção — 429 significa
 * "volta daqui a pouco", então pausa curta em vez da pausa longa de crédito.
 */
function pausaPara(err) {
  const status = err?.response?.status;
  if (status === 429) return 5 * 60 * 1000;
  if (status === 401 || status === 403) return 60 * 60 * 1000;
  return null;
}

/**
 * Nem todo modelo grátis aceita response_format json_object (os :free do
 * OpenRouter são o caso comum). Quando não aceita, a instrução vai no texto —
 * o parseArtigoJson do chamador continua recebendo JSON.
 */
function prepararMensagens(messages, json, suportaJson) {
  if (!json || suportaJson) return messages;
  const copia = (messages || []).map((m) => ({ ...m }));
  const idx = copia.findIndex((m) => m && m.role === 'system');
  const regra =
    '\n\nResponda APENAS com um objeto JSON válido, sem markdown, sem cercas de código e sem texto antes ou depois.';
  if (idx >= 0) copia[idx].content = `${copia[idx].content || ''}${regra}`;
  else copia.unshift({ role: 'system', content: regra.trim() });
  return copia;
}

/** Modelo que ignorou a ordem e devolveu a resposta dentro de cerca de código. */
function limparCercaJson(texto) {
  const t = String(texto || '').trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function chamarProvedor(nome, messages, { temperature, json, timeout }) {
  const p = PROVEDORES[nome];
  const modelo = modeloDe(nome);
  const body = {
    model: modelo,
    temperature,
    messages: prepararMensagens(messages, json, p.suportaJson),
  };
  if (json && p.suportaJson) body.response_format = { type: 'json_object' };

  const inicio = Date.now();
  const { data } = await axios.post(p.url, body, {
    headers: {
      Authorization: `Bearer ${chaveDe(nome)}`,
      'Content-Type': 'application/json',
    },
    timeout,
  });
  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  const tokens = data?.usage?.total_tokens || '?';
  console.log(`[free-tier] ${nome}/${modelo} ${segundos}s tokens=${tokens}`);

  const raw = data?.choices?.[0]?.message?.content || '';
  if (!String(raw).trim()) throw new Error(`${nome} retornou resposta vazia`);
  return json ? limparCercaJson(raw) : String(raw).trim();
}

/**
 * Mesma assinatura do chatCompletion da DeepSeek e do Claude, com uma
 * diferença de contrato importante: devolve null em vez de lançar quando
 * nenhum provedor grátis atendeu. Falha aqui não pode quebrar a matéria — o
 * chamador segue para o provedor pago.
 */
async function chatCompletion(messages, { temperature = 0.7, json = true, timeout = 60_000 } = {}) {
  const disponiveis = provedoresDisponiveis();
  if (!disponiveis.length) return null;

  for (const nome of disponiveis) {
    try {
      const raw = await chamarProvedor(nome, messages, { temperature, json, timeout });
      providerHealth.registrarSucesso(`free:${nome}`);
      return raw;
    } catch (err) {
      const motivo = mensagemDeErro(err);
      providerHealth.registrarFalha(`free:${nome}`, motivo, { pausaMs: pausaPara(err) });
      console.warn(`[free-tier] ${nome} falhou: ${motivo}`);
    }
  }
  return null;
}

/**
 * Streaming grátis. O onDelta continua sendo chamado token a token para a tela
 * do /materia-manual não travar. Sem provedor disponível devolve null.
 */
async function chatCompletionStream(
  messages,
  { temperature = 0.7, onDelta = null, timeout = 120_000 } = {}
) {
  const disponiveis = provedoresDisponiveis();
  if (!disponiveis.length) return null;

  for (const nome of disponiveis) {
    const p = PROVEDORES[nome];
    let full = '';
    try {
      const response = await axios.post(
        p.url,
        {
          model: modeloDe(nome),
          temperature,
          messages,
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${chaveDe(nome)}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          responseType: 'stream',
          timeout,
        }
      );

      await new Promise((resolve, reject) => {
        let buffer = '';
        response.data.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const linhas = buffer.split('\n');
          buffer = linhas.pop() || '';
          for (const linha of linhas) {
            const l = linha.trim();
            if (!l.startsWith('data:')) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed?.choices?.[0]?.delta?.content || '';
              if (delta) {
                full += delta;
                if (typeof onDelta === 'function') onDelta(delta);
              }
            } catch {
              /* pedaço incompleto — ignora */
            }
          }
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });

      if (full.trim()) {
        providerHealth.registrarSucesso(`free:${nome}`);
        return full.trim();
      }
      throw new Error(`${nome} devolveu stream vazio`);
    } catch (err) {
      const motivo = mensagemDeErro(err);
      providerHealth.registrarFalha(`free:${nome}`, motivo, { pausaMs: pausaPara(err) });
      console.warn(`[free-tier-stream] ${nome} falhou: ${motivo}`);
      // Deltas já foram para a tela. Tentar outro provedor (ou cair no pago)
      // reescreveria o texto do zero e o usuário veria a resposta duplicada —
      // então o parcial é o resultado final desta chamada.
      if (full.trim()) return full.trim();
    }
  }
  return null;
}

module.exports = {
  isConfigured,
  cobreTarefa,
  provedoresDisponiveis,
  statusProvedores,
  chatCompletion,
  chatCompletionStream,
};
