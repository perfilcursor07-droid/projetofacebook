const axios = require('axios');
const { env } = require('../config/env');
const deepseekService = require('./deepseekService');
const pexelsService = require('./pexelsService');

function imagemPareceRuim(item) {
  const hay = `${item.url || ''} ${item.titulo || ''} ${item.fonte || ''}`.toLowerCase();
  return /logo|sprite|icon|avatar|emoji|favicon|1x1|pixel|banner-ad|tracking/i.test(hay);
}

function serperSemCredito(err) {
  const msg = String(err.response?.data?.message || err.message || '').toLowerCase();
  return msg.includes('not enough credits') || msg.includes('insufficient credits');
}

async function buscarSerperImagens(consulta, { num = 10 } = {}) {
  if (!env.serperApiKey) return { imagens: [], esgotado: false };
  try {
    const { data } = await axios.post(
      'https://google.serper.dev/images',
      { q: consulta, num },
      {
        headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    const imagens = (data?.images || [])
      .map((img, idx) => ({
        id: `serper:${idx}:${String(img.imageUrl || '').slice(-36)}`,
        url: img.imageUrl || null,
        thumbnail: img.thumbnailUrl || img.imageUrl || null,
        titulo: img.title || consulta,
        fonte: img.source || img.domain || null,
        link: img.link || null,
        largura: img.imageWidth || null,
        altura: img.imageHeight || null,
        origem: 'google',
        consulta,
      }))
      .filter((i) => i.url && /^https?:\/\//i.test(i.url) && !imagemPareceRuim(i));
    return { imagens, esgotado: false };
  } catch (err) {
    if (serperSemCredito(err)) {
      console.warn('[sugerirImagens] serper: sem créditos');
      return { imagens: [], esgotado: true };
    }
    console.warn('[sugerirImagens] serper:', err.response?.data?.message || err.message);
    return { imagens: [], esgotado: false };
  }
}

/**
 * Brave Images — bom para pessoa específica (fotos reais).
 */
async function buscarBraveImagens(consulta, { count = 10 } = {}) {
  if (!env.braveSearchApiKey) return [];
  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/images/search', {
      params: { q: consulta, count: Math.min(count, 20) },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
      timeout: 20000,
    });

    return (data?.results || [])
      .map((img, idx) => {
        const url = img.properties?.url || img.url || null;
        const thumbnail = img.thumbnail?.src || url;
        // Preferir URL da imagem, não a página Getty
        const imageUrl =
          url && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)
            ? url
            : img.properties?.url || thumbnail;
        return {
          id: `brave:${idx}:${String(imageUrl || '').slice(-36)}`,
          url: imageUrl,
          thumbnail,
          titulo: img.title || consulta,
          fonte: img.source || null,
          link: img.url || null,
          largura: img.properties?.width || img.thumbnail?.width || null,
          altura: img.properties?.height || img.thumbnail?.height || null,
          origem: 'brave',
          consulta,
        };
      })
      .filter((i) => i.url && /^https?:\/\//i.test(i.url) && !imagemPareceRuim(i));
  } catch (err) {
    console.warn('[sugerirImagens] brave:', err.response?.data?.error?.detail || err.message);
    return [];
  }
}

async function buscarPexelsImagens(consulta, { perPage = 6 } = {}) {
  if (!env.pexelsApiKey) return [];
  try {
    const result = await pexelsService.searchPhotos(consulta, {
      perPage,
      orientation: 'portrait',
    });
    return (result.photos || []).map((p) => ({
      id: `pexels:${p.pexelsId}`,
      url: p.urlOriginal,
      thumbnail: p.thumbnail,
      titulo: p.alt || consulta,
      fonte: p.autor ? `Pexels · ${p.autor}` : 'Pexels',
      link: p.url,
      largura: p.largura,
      altura: p.altura,
      origem: 'pexels',
      consulta,
    }));
  } catch (err) {
    console.warn('[sugerirImagens] pexels:', err.message);
    return [];
  }
}

async function buscarImagensConsulta(consulta, { temPessoa, serperEsgotadoRef }) {
  // 1) Serper (se ainda tiver crédito)
  if (env.serperApiKey && !serperEsgotadoRef.value) {
    const { imagens, esgotado } = await buscarSerperImagens(consulta, { num: 10 });
    if (esgotado) serperEsgotadoRef.value = true;
    if (imagens.length) return imagens;
  }

  // 2) Brave — prioridade para pessoa específica
  const brave = await buscarBraveImagens(consulta, { count: 12 });
  if (brave.length) return brave;

  // 3) Pexels só sem pessoa nomeada
  if (!temPessoa) return buscarPexelsImagens(consulta, { perPage: 8 });
  return [];
}

/**
 * IA analisa a matéria → busca fotos reais (Serper → Brave → Pexels).
 */
async function sugerirImagensParaMateria({
  titulo,
  materia,
  fonteTitulo,
  imagemAtual = null,
  limite = 12,
}) {
  deepseekService.assertDeepseek();

  const plano = await deepseekService.sugerirConsultasImagem({
    titulo,
    materia,
    fonteTitulo,
  });

  const temPessoa = Boolean(plano.pessoa);
  const vistos = new Set();
  const imagens = [];
  const consultasUsadas = [];
  const serperEsgotadoRef = { value: false };
  let fonteUsada = null;

  // Inclui a imagem atual/fonte como 1ª opção
  if (imagemAtual && /^https?:\/\//i.test(imagemAtual)) {
    const key = imagemAtual.split('?')[0].toLowerCase();
    vistos.add(key);
    imagens.push({
      id: 'atual',
      url: imagemAtual,
      thumbnail: imagemAtual,
      titulo: 'Imagem atual / fonte',
      fonte: 'Fonte',
      origem: 'fonte',
      consulta: null,
    });
  }

  for (const consulta of plano.consultas) {
    consultasUsadas.push(consulta);
    const batch = await buscarImagensConsulta(consulta, { temPessoa, serperEsgotadoRef });
    if (batch[0]?.origem && !fonteUsada) fonteUsada = batch[0].origem;

    for (const img of batch) {
      const key = String(img.url).split('?')[0].toLowerCase();
      if (vistos.has(key)) continue;
      if (img.largura && img.altura && (img.largura < 350 || img.altura < 350)) continue;
      vistos.add(key);
      imagens.push(img);
      if (imagens.length >= limite) break;
    }
    if (imagens.length >= limite) break;
  }

  if (imagens.length <= (imagemAtual ? 1 : 0) && !temPessoa && plano.consultas[0]) {
    const fallback = await buscarPexelsImagens(plano.consultas[0], { perPage: limite });
    for (const img of fallback) {
      const key = String(img.url).split('?')[0].toLowerCase();
      if (vistos.has(key)) continue;
      vistos.add(key);
      imagens.push(img);
      fonteUsada = fonteUsada || 'pexels';
    }
  }

  if (!imagens.length || (imagens.length === 1 && imagens[0].origem === 'fonte' && temPessoa)) {
    const extra = serperEsgotadoRef.value
      ? ' Serper sem créditos — use Brave (BRAVE_SEARCH_API_KEY) ou recarregue créditos do Serper.'
      : '';
    if (imagens.length <= (imagemAtual ? 1 : 0)) {
      const err = new Error(
        (temPessoa
          ? `Não encontramos fotos de “${plano.pessoa}”.`
          : 'Nenhuma imagem sugerida.') + extra
      );
      err.status = 422;
      throw err;
    }
  }

  return {
    pessoa: plano.pessoa,
    motivo: plano.motivo,
    consultas: consultasUsadas,
    imagens: imagens.slice(0, limite),
    fontePreferida: fonteUsada || (env.braveSearchApiKey ? 'brave' : 'serper'),
    aviso: serperEsgotadoRef.value
      ? 'Serper sem créditos — sugestões via Brave Images.'
      : null,
  };
}

module.exports = {
  sugerirImagensParaMateria,
  buscarSerperImagens,
  buscarBraveImagens,
};
