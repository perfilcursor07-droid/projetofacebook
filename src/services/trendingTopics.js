const {
  buscarGoogleNewsEmAlta,
  buscarGoogleNewsRss,
  buscarBraveNews,
  buscarSerperRedes,
  itemEhRecente,
  titulosSimilares,
  deduplicarTopicos,
} = require('./newsResearch');
const { apurarTopico } = require('./articleSource');

const TERMOS_RADAR = ['gospel', 'pastor', 'igreja', 'fé', 'louvor', 'brasil'];

function pesoTipoFonte(item) {
  if (item.emAlta) return 4;
  if (item.tipoFonte === 'rede_social' || item.redeSocial) return 3;
  return 2;
}

function agruparPorAssunto(itens) {
  const grupos = [];
  for (const item of itens) {
    const grupo = grupos.find((g) => titulosSimilares(g.principal.titulo, item.titulo));
    if (grupo) {
      grupo.itens.push(item);
      const melhor =
        item.tipoFonte !== 'rede_social' &&
        (grupo.principal.tipoFonte === 'rede_social' ||
          (item.resumo || '').length > (grupo.principal.resumo || '').length);
      if (melhor) grupo.principal = item;
    } else {
      grupos.push({ principal: item, itens: [item] });
    }
  }

  return grupos.map((g) => {
    const veiculos = new Set(g.itens.map((i) => (i.veiculo || i.fonte || '').trim().toLowerCase()).filter(Boolean));
    const temRede = g.itens.some((i) => i.tipoFonte === 'rede_social' || i.redeSocial);
    const temTrend = g.itens.some((i) => i.emAlta);
    const calor =
      g.itens.reduce((soma, i) => soma + pesoTipoFonte(i), 0) +
      veiculos.size * 3 +
      (temTrend ? 5 : 0) +
      (temRede ? 2 : 0);

    return {
      ...g.principal,
      emAltaAgora: true,
      emAlta: true,
      calor,
      contagemFontes: g.itens.length,
      veiculos: [...new Set(g.itens.map((i) => i.veiculo || i.fonte).filter(Boolean))].slice(0, 5),
      sinalRedes: temRede,
      sinalTrends: temTrend,
    };
  });
}

/**
 * Radar “em alta agora” — opcionalmente com termos extras.
 */
async function buscarEmAltaAgora(termosExtras = '', opcoes = {}) {
  const horas = opcoes.horas === 48 || opcoes.horas === '48' ? 48 : 24;
  const termos = [...TERMOS_RADAR];

  String(termosExtras || '')
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .forEach((t) => {
      if (!termos.some((x) => x.toLowerCase() === t.toLowerCase())) termos.push(t);
    });

  const promessas = [];
  for (const termo of termos.slice(0, 8)) {
    promessas.push(buscarGoogleNewsEmAlta(termo));
    promessas.push(buscarGoogleNewsRss(termo, { when: '1d' }));
    promessas.push(buscarBraveNews(termo, 1));
  }
  for (const termo of termos.slice(0, 3)) {
    promessas.push(buscarSerperRedes(termo));
  }

  const bruto = (await Promise.all(promessas)).flat();
  const filtrados = deduplicarTopicos(
    bruto.filter((i) => itemEhRecente(i, { horas }) || i.emAlta)
  );
  const agrupados = agruparPorAssunto(filtrados)
    .sort((a, b) => b.calor - a.calor)
    .slice(0, 15)
    .map((t, idx) => ({ ...t, posicao: idx + 1 }));

  const topicos = [];
  for (const item of agrupados.slice(0, 10)) {
    try {
      topicos.push(await apurarTopico(item));
    } catch {
      topicos.push(item);
    }
  }

  return {
    topicos,
    totalAnalisado: filtrados.length,
    horas,
  };
}

module.exports = { buscarEmAltaAgora };
