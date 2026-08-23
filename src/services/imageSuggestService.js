const axios = require('axios');
const { env } = require('../config/env');
const deepseekService = require('./deepseekService');
const pexelsService = require('./pexelsService');

/**
 * Falhas dos provedores na requisição atual. Sem isso, quando todos falham a
 * tela só dizia "nenhuma imagem encontrada" e não dava para saber que o
 * problema era chave sem crédito ou token desativado.
 */
const falhasProvedor = {
  atual: [],
  iniciar() {
    this.atual = [];
  },
  registrar(provedor, motivo) {
    const texto = String(motivo || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!texto) return;
    if (this.atual.some((f) => f.provedor === provedor)) return;
    this.atual.push({ provedor, motivo: texto });
  },
  resumo() {
    return this.atual.map((f) => f.provedor + ': ' + f.motivo);
  },
};

function imagemPareceRuim(item) {
  const hay = `${item.url || ''} ${item.titulo || ''} ${item.fonte || ''}`.toLowerCase();
  return /logo|sprite|icon|avatar|emoji|favicon|1x1|pixel|banner-ad|tracking/i.test(hay);
}

function serperSemCredito(err) {
  const msg = String(err.response?.data?.message || err.message || '').toLowerCase();
  return msg.includes('not enough credits') || msg.includes('insufficient credits');
}

/**
 * SerpApi Google Images — preferido para pessoa/assunto específico.
 * Docs: https://serpapi.com/search?engine=google_images
 */
async function buscarSerpApiImagens(consulta, { num = 12 } = {}) {
  const providerHealth = require('./providerHealth');
  if (!env.serpApiKey || providerHealth.estaFora('serpapi')) return [];
  try {
    const { data } = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_images',
        q: consulta,
        hl: 'pt-br',
        gl: 'br',
        api_key: env.serpApiKey,
        // ijn: 0 = primeira página
        ijn: 0,
      },
      timeout: 30000,
    });

    const list = data?.images_results || [];
    return list
      .slice(0, num)
      .map((img, idx) => ({
        id: `serpapi:${idx}:${String(img.original || img.link || '').slice(-36)}`,
        url: img.original || img.link || null,
        thumbnail: img.thumbnail || img.original || null,
        titulo: img.title || consulta,
        fonte: img.source || img.domain || null,
        link: img.link || null,
        largura: img.original_width || null,
        altura: img.original_height || null,
        origem: 'serpapi',
        consulta,
      }))
      .filter((i) => i.url && /^https?:\/\//i.test(i.url) && !imagemPareceRuim(i));
  } catch (err) {
    console.warn(
      '[sugerirImagens] serpapi:',
      err.response?.data?.error || err.message
    );
    falhasProvedor.registrar('SerpApi', err.response?.data?.error || err.message);
    require('./providerHealth').registrarFalha('serpapi', err.response?.data?.error || err.message);
    return [];
  }
}

async function buscarSerperImagens(consulta, { num = 10 } = {}) {
  const providerHealth = require('./providerHealth');
  if (!env.serperApiKey || providerHealth.estaFora('serper')) {
    return { imagens: [], esgotado: true };
  }
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
      falhasProvedor.registrar('Serper', 'sem créditos na conta');
      require('./providerHealth').registrarFalha('serper', 'sem créditos na conta');
      return { imagens: [], esgotado: true };
    }
    console.warn('[sugerirImagens] serper:', err.response?.data?.message || err.message);
    falhasProvedor.registrar('Serper', err.response?.data?.message || err.message);
    return { imagens: [], esgotado: false };
  }
}

async function buscarBraveImagens(consulta, { count = 10 } = {}) {
  const providerHealth = require('./providerHealth');
  if (!env.braveImageApiKey || providerHealth.estaFora('brave-images')) return [];
  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/images/search', {
      params: { q: consulta, count: Math.min(count, 20) },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': env.braveImageApiKey,
      },
      timeout: 20000,
    });

    return (data?.results || [])
      .map((img, idx) => {
        const url = img.properties?.url || null;
        const thumbnail = img.thumbnail?.src || url;
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
    falhasProvedor.registrar('Brave', err.response?.data?.error?.detail || err.message);
    require('./providerHealth').registrarFalha(
      'brave-images',
      err.response?.data?.error?.detail || err.message
    );
    return [];
  }
}

/**
 * Fallback sem chave: busca reportagens no Google News e usa a imagem de capa
 * publicada pelo próprio veículo. É mais aderente à matéria que uma foto de
 * stock e continua funcionando quando SerpApi/Serper/Brave ficam sem cota.
 */
async function buscarGoogleNewsImagens(consulta, { count = 10 } = {}) {
  try {
    const { buscarGoogleNewsRss } = require('./newsResearch');
    const { extrairMetadadosImagemArtigo } = require('./articleSource');
    const noticias = await buscarGoogleNewsRss(consulta, {
      when: '365d',
      resolverDiretas: true,
      incluirWebGeral: true,
    });

    const tokens = (valor) =>
      new Set(
        String(valor || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((palavra) => palavra.length >= 4)
      );
    const esperados = tokens(consulta);
    const relacionada = (noticia) => {
      if (!esperados.size) return true;
      const tituloTokens = tokens(noticia?.titulo);
      let comuns = 0;
      for (const token of esperados) if (tituloTokens.has(token)) comuns += 1;
      return esperados.size <= 2 ? comuns >= 1 : comuns >= 2;
    };
    const noticiasRelacionadas = (noticias || []).filter(relacionada);

    // Algumas páginas bloqueiam robôs. Consultar mais candidatas que o total
    // pedido mantém boa chance de obter capas sem sobrecarregar os veículos.
    // Se o título veio muito diferente do texto pesquisado, ainda confiamos no
    // ranking do Google em vez de zerar a busca inteira.
    const candidatas = (noticiasRelacionadas.length ? noticiasRelacionadas : noticias || []).slice(
      0,
      Math.min(10, Math.max(6, count))
    );
    const metas = await Promise.all(
      candidatas.map((noticia) =>
        extrairMetadadosImagemArtigo(noticia.link)
          .then((meta) => ({ noticia, meta }))
          .catch(() => ({ noticia, meta: null }))
      )
    );

    const vistos = new Set();
    const imagens = [];
    for (let idx = 0; idx < metas.length && imagens.length < count; idx += 1) {
      const { noticia, meta } = metas[idx];
      const imageUrl = meta?.imagem;
      if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) continue;
      // O título no RSS pode divergir do <title>/og:title da página final.
      // Valida novamente depois do redirect para não oferecer capa de outra
      // notícia (comum em portais que redirecionam páginas antigas).
      if (noticiasRelacionadas.length && !relacionada({ titulo: meta.titulo || noticia.titulo })) {
        continue;
      }
      const key = imageUrl.split('?')[0].toLowerCase();
      if (vistos.has(key)) continue;
      vistos.add(key);
      imagens.push({
        id: `google-news:${idx}:${String(imageUrl).slice(-36)}`,
        url: imageUrl,
        thumbnail: imageUrl,
        titulo: meta.titulo || noticia.titulo || consulta,
        fonte: meta.veiculo || noticia.veiculo || 'Google News',
        link: meta.url || noticia.link || null,
        largura: null,
        altura: null,
        origem: 'google-news',
        consulta,
      });
    }
    return imagens.filter((item) => !imagemPareceRuim(item));
  } catch (err) {
    console.warn('[sugerirImagens] google-news:', err.message);
    falhasProvedor.registrar('Google News', err.message);
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
      autor: p.autor || null,
      link: p.url,
      largura: p.largura,
      altura: p.altura,
      origem: 'pexels',
      consulta,
    }));
  } catch (err) {
    console.warn('[sugerirImagens] pexels:', err.message);
    falhasProvedor.registrar('Pexels', err.message);
    return [];
  }
}

/**
 * Termos comuns em pt-BR → inglês, para o Pexels (banco de fotos em inglês).
 * Sem isso, uma busca simples como "padre" só devolvia imagem quando o Google
 * respondia: no Pexels, "padre" praticamente não retorna nada.
 */
const TERMOS_PT_EN = Object.freeze({
  padre: 'catholic priest',
  padres: 'catholic priests',
  pastor: 'pastor preaching',
  pastores: 'pastors preaching',
  igreja: 'church',
  igrejas: 'churches',
  missa: 'catholic mass',
  culto: 'worship service',
  bispo: 'bishop',
  papa: 'pope',
  freira: 'nun',
  freiras: 'nuns',
  bíblia: 'bible',
  biblia: 'bible',
  oração: 'praying',
  oracao: 'praying',
  fiéis: 'church congregation',
  fieis: 'church congregation',
  templo: 'temple',
  cruz: 'cross',
  batismo: 'baptism',
  evangélico: 'evangelical church',
  evangelico: 'evangelical church',
  católico: 'catholic',
  catolico: 'catholic',
  polícia: 'police',
  policia: 'police',
  prisão: 'prison',
  prisao: 'prison',
  delegacia: 'police station',
  tribunal: 'courthouse',
  juiz: 'judge',
  hospital: 'hospital',
  escola: 'school',
  família: 'family',
  familia: 'family',
  criança: 'child',
  crianca: 'child',
  dinheiro: 'money',
  bandeira: 'flag',
  política: 'politics',
  politica: 'politics',
});

/** Versão em inglês da consulta, quando dá para traduzir termo a termo. */
function consultaParaPexels(consulta) {
  const palavras = String(consulta || '')
    .toLowerCase()
    .split(/[ ,]+/)
    .filter(Boolean);
  if (!palavras.length) return null;

  let traduziu = false;
  const saida = palavras.map((palavra) => {
    const traducao = TERMOS_PT_EN[palavra];
    if (traducao) {
      traduziu = true;
      return traducao;
    }
    return palavra;
  });
  return traduziu ? saida.join(' ') : null;
}

/**
 * Junta o resultado de TODOS os provedores disponíveis.
 *
 * Antes valia o primeiro que respondesse: com o SerpApi fora do ar (ou sem
 * cota), a busca inteira voltava vazia mesmo com Brave/Pexels funcionando —
 * era o caso de "padre" não trazer nada de vez em quando.
 */
async function buscarImagensConsulta(consulta, { temPessoa, serperEsgotadoRef, minimo = 6 }) {
  const encontradas = [];
  const juntar = (lista) => {
    for (const img of lista || []) encontradas.push(img);
  };

  juntar(await buscarSerpApiImagens(consulta, { num: 12 }));

  if (encontradas.length < minimo && env.serperApiKey && !serperEsgotadoRef.value) {
    const { imagens, esgotado } = await buscarSerperImagens(consulta, { num: 10 });
    if (esgotado) serperEsgotadoRef.value = true;
    juntar(imagens);
  }

  if (encontradas.length < minimo) {
    juntar(await buscarBraveImagens(consulta, { count: 12 }));
  }

  if (encontradas.length < minimo) {
    juntar(await buscarGoogleNewsImagens(consulta, { count: 10 }));
  }

  // Pexels é banco de stock: não serve para pessoa nomeada, mas resolve
  // assunto genérico. A consulta vai traduzida quando dá.
  if (encontradas.length < minimo && !temPessoa) {
    juntar(await buscarPexelsImagens(consulta, { perPage: 8 }));
    const emIngles = consultaParaPexels(consulta);
    if (emIngles && encontradas.length < minimo) {
      juntar(await buscarPexelsImagens(emIngles, { perPage: 8 }));
    }
  }

  return encontradas;
}


/**
 * Consultas montadas do próprio título, sem IA. É o plano B de "Trocar imagem":
 * a busca de fotos não pode depender do modelo estar de pé.
 */
function planoDeConsultasSemIa({ titulo, fonteTitulo }) {
  const limpo = String(titulo || '')
    .replace(/\[\[|\]\]|\(\(|\)\)/g, ' ')
    .replace(/["'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const consultas = [];
  if (limpo) {
    consultas.push(limpo.slice(0, 120));
    const palavras = limpo.split(' ');
    if (palavras.length > 6) consultas.push(palavras.slice(0, 6).join(' '));
  }
  const fonte = String(fonteTitulo || '').replace(/\s+/g, ' ').trim();
  if (fonte && fonte.toLowerCase() !== limpo.toLowerCase()) consultas.push(fonte.slice(0, 120));

  // Duas maiúsculas seguidas = provável nome de pessoa. Marcar isso evita cair
  // em banco de stock genérico quando a matéria é sobre alguém.
  const pessoa = /\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ]+/.test(limpo);

  return { consultas: consultas.filter(Boolean).slice(0, 3), pessoa };
}

/**
 * IA analisa a matéria → busca fotos reais
 * (SerpApi → Serper → Brave → capas do Google News → Pexels).
 */
async function sugerirImagensParaMateria({
  titulo,
  materia,
  fonteTitulo,
  imagemAtual = null,
  limite = 12,
}) {
  falhasProvedor.iniciar();

  // A IA só melhora as consultas; se ela falhar, o título ainda dá busca boa.
  let plano = null;
  try {
    deepseekService.assertDeepseek();
    plano = await deepseekService.sugerirConsultasImagem({ titulo, materia, fonteTitulo });
  } catch (err) {
    console.warn('[sugerirImagens] planejar consultas com IA falhou:', err.message);
    falhasProvedor.registrar('IA', err.message);
  }
  if (!plano?.consultas?.length) {
    plano = planoDeConsultasSemIa({ titulo, fonteTitulo });
    console.log('[sugerirImagens] usando consultas do título:', plano.consultas.join(' | '));
  }

  const temPessoa = Boolean(plano.pessoa);
  const vistos = new Set();
  const imagens = [];
  const consultasUsadas = [];
  const serperEsgotadoRef = { value: false };
  let fonteUsada = null;

  if (imagemAtual && /^https?:\/\//i.test(imagemAtual)) {
    const key = imagemAtual.split('?')[0].toLowerCase();
    vistos.add(key);
    imagens.push({
      id: 'atual',
      url: imagemAtual,
      thumbnail: imagemAtual,
      titulo: 'Foto do post / fonte',
      fonte: 'Post',
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
    if (imagens.length <= (imagemAtual ? 1 : 0)) {
      const err = new Error(
        temPessoa
          ? `Não encontramos fotos de “${plano.pessoa}” nos buscadores nem nas reportagens relacionadas.`
          : 'Nenhuma imagem sugerida nos buscadores nem nas reportagens relacionadas.'
      );
      err.status = 422;
      throw err;
    }
  }

  const avisoParts = [];
  if (fonteUsada === 'serpapi') avisoParts.push('Fotos via SerpApi (Google Images)');
  else if (fonteUsada === 'brave') avisoParts.push('Fotos via Brave Images');
  else if (fonteUsada === 'google') avisoParts.push('Fotos via Serper');
  else if (fonteUsada === 'google-news') avisoParts.push('Fotos editoriais via Google News');
  if (serperEsgotadoRef.value) avisoParts.push('Serper.dev sem créditos');

  return {
    pessoa: plano.pessoa,
    motivo: plano.motivo,
    consultas: consultasUsadas,
    imagens: imagens.slice(0, limite),
    fontePreferida: fonteUsada || (env.serpApiKey ? 'serpapi' : env.braveImageApiKey ? 'brave' : 'pexels'),
    aviso: avisoParts.length ? avisoParts.join(' · ') : null,
  };
}

/**
 * Busca fotos por palavra-chave digitada (sem IA).
 * Mesma cadeia: SerpApi → Serper → Brave → Google News → Pexels.
 */
async function buscarImagensPorPalavra(consultaRaw, { limite = 12 } = {}) {
  const consulta = String(consultaRaw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  if (consulta.length < 2) {
    const err = new Error('Digite pelo menos 2 caracteres para buscar.');
    err.status = 400;
    throw err;
  }

  falhasProvedor.iniciar();
  const serperEsgotadoRef = { value: false };
  const batch = await buscarImagensConsulta(consulta, {
    temPessoa: false,
    serperEsgotadoRef,
    minimo: limite,
  });

  const vistos = new Set();
  const imagens = [];
  const origens = new Set();

  // 1ª passada exige foto grande; a 2ª aceita qualquer tamanho, senão uma
  // busca simples voltava vazia só porque os provedores devolveram thumbs.
  const coletar = ({ exigirTamanho }) => {
    for (const img of batch) {
      if (imagens.length >= limite) return;
      const key = String(img.url || '')
        .split('?')[0]
        .toLowerCase();
      if (!key || vistos.has(key)) continue;
      if (exigirTamanho && img.largura && img.altura && (img.largura < 350 || img.altura < 350)) {
        continue;
      }
      vistos.add(key);
      imagens.push({ ...img, consulta });
      if (img.origem) origens.add(img.origem);
    }
  };
  coletar({ exigirTamanho: true });
  if (!imagens.length) coletar({ exigirTamanho: false });

  if (!imagens.length) {
    // Todos os provedores falharam: dizer QUAL falhou evita caçar bug no escuro.
    const motivos = falhasProvedor.resumo();
    const err = new Error(
      motivos.length
        ? `Nenhuma imagem encontrada para “${consulta}”. Provedores fora do ar — ${motivos.join(' · ')}.`
        : `Nenhuma imagem encontrada para “${consulta}”. Tente outra palavra (ex.: mais específica ou em inglês).`
    );
    err.status = 422;
    throw err;
  }

  const rotulos = {
    serpapi: 'SerpApi (Google Images)',
    google: 'Serper',
    brave: 'Brave Images',
    'google-news': 'Google News (capa dos veículos)',
    pexels: 'Pexels',
  };
  const avisoParts = [];
  const usadas = [...origens].map((o) => rotulos[o] || o).filter(Boolean);
  if (usadas.length) avisoParts.push(`Fotos via ${usadas.join(' + ')}`);
  const motivos = falhasProvedor.resumo();
  if (motivos.length) avisoParts.push(`Sem resposta de ${motivos.join(' · ')}`);
  avisoParts.push(`Busca: ${consulta}`);

  return {
    pessoa: null,
    motivo: `Busca manual: ${consulta}`,
    consultas: [consulta],
    imagens: imagens.slice(0, limite),
    fontePreferida: [...origens][0] || 'brave',
    aviso: avisoParts.join(' · '),
  };
}


module.exports = {
  sugerirImagensParaMateria,
  buscarImagensPorPalavra,
  buscarSerpApiImagens,
  buscarSerperImagens,
  buscarBraveImagens,
  buscarGoogleNewsImagens,
};
