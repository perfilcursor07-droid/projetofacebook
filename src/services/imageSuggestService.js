const axios = require('axios');
const { env } = require('../config/env');
const deepseekService = require('./deepseekService');
const pexelsService = require('./pexelsService');

function imagemPareceRuim(item) {
  const hay = `${item.url || ''} ${item.titulo || ''} ${item.fonte || ''}`.toLowerCase();
  return /logo|sprite|icon|avatar|emoji|favicon|1x1|pixel|banner-ad|tracking/i.test(hay);
}

async function buscarSerperImagens(consulta, { num = 10 } = {}) {
  if (!env.serperApiKey) return [];
  const { data } = await axios.post(
    'https://google.serper.dev/images',
    { q: consulta, num, gl: 'br', hl: 'pt-br' },
    {
      headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );

  return (data?.images || [])
    .map((img, idx) => ({
      id: `serper:${consulta}:${idx}:${String(img.imageUrl || '').slice(-40)}`,
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

/**
 * IA analisa a matéria → busca imagens reais (Serper/Google).
 * Pexels só como último recurso quando NÃO há pessoa nomeada.
 */
async function sugerirImagensParaMateria({ titulo, materia, fonteTitulo, limite = 12 }) {
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

  for (const consulta of plano.consultas) {
    consultasUsadas.push(consulta);
    let batch = [];
    if (env.serperApiKey) {
      try {
        batch = await buscarSerperImagens(consulta, { num: 10 });
      } catch (err) {
        console.warn('[sugerirImagens] serper:', err.message);
      }
    }

    // Sem pessoa específica e Serper vazio → Pexels temático
    if (!batch.length && !temPessoa) {
      batch = await buscarPexelsImagens(consulta, { perPage: 8 });
    }

    for (const img of batch) {
      const key = String(img.url).split('?')[0].toLowerCase();
      if (vistos.has(key)) continue;
      // Preferir imagens com tamanho razoável quando informado
      if (img.largura && img.altura && (img.largura < 400 || img.altura < 400)) continue;
      vistos.add(key);
      imagens.push(img);
      if (imagens.length >= limite) break;
    }
    if (imagens.length >= limite) break;
  }

  // Último recurso: Pexels genérico só se ainda vazio e sem pessoa
  if (!imagens.length && !temPessoa && plano.consultas[0]) {
    const fallback = await buscarPexelsImagens(plano.consultas[0], { perPage: limite });
    for (const img of fallback) {
      const key = String(img.url).split('?')[0].toLowerCase();
      if (vistos.has(key)) continue;
      vistos.add(key);
      imagens.push(img);
    }
  }

  if (!imagens.length) {
    const err = new Error(
      temPessoa
        ? `Não encontramos fotos de “${plano.pessoa}”. Confira SERPER_API_KEY ou tente outro ângulo.`
        : 'Nenhuma imagem sugerida. Configure SERPER_API_KEY (Google Images) no .env.'
    );
    err.status = 422;
    throw err;
  }

  return {
    pessoa: plano.pessoa,
    motivo: plano.motivo,
    consultas: consultasUsadas,
    imagens: imagens.slice(0, limite),
    fontePreferida: env.serperApiKey ? 'google' : 'pexels',
  };
}

module.exports = {
  sugerirImagensParaMateria,
  buscarSerperImagens,
};
