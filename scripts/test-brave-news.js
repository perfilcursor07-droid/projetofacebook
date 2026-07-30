/**
 * Diagnóstico da Brave Search API (news + web).
 * Útil quando a busca volta vazia: mostra status/detalhe do erro por combinação de parâmetros.
 * Uso: node scripts/test-brave-news.js "termo de busca"
 */
require('dotenv').config();

const axios = require('axios');
const { env } = require('../src/config/env');

const termo = process.argv[2] || 'catolicos evangelicos eleicoes 2026';

async function chamar(endpoint, params) {
  const label = `${endpoint} ${JSON.stringify({ ...params, q: '<termo>' })}`;
  try {
    const { data } = await axios.get(`https://api.search.brave.com/res/v1/${endpoint}`, {
      params,
      headers: { Accept: 'application/json', 'X-Subscription-Token': env.braveSearchApiKey },
      timeout: 15000,
    });
    const total = (data.results || data.web?.results || []).length;
    console.log('OK   ', label, '→ resultados:', total);
  } catch (err) {
    const detalhe =
      err.response?.data?.error?.detail ||
      err.response?.data?.error?.meta?.errors?.[0]?.msg ||
      err.response?.data?.message ||
      err.message;
    console.log('FALHA', label, '→', err.response?.status, detalhe);
  }
}

async function main() {
  if (!env.braveSearchApiKey) {
    console.log('Sem BRAVE_SEARCH_API_KEY no .env');
    return;
  }
  // search_lang precisa ser 'pt-br'; 'pt' devolve 422 "Unable to validate request parameter(s)"
  await chamar('news/search', { q: termo, count: 20, country: 'BR', search_lang: 'pt-br', freshness: 'pm' });
  await chamar('news/search', { q: termo, count: 10 });
  await chamar('web/search', { q: termo, count: 8, country: 'BR', search_lang: 'pt-br' });
}

main().catch((e) => console.error(e.message));
