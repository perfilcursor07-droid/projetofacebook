/**
 * Extras do chat de matérias (/materia-manual):
 *  - "Em alta": radar dos assuntos do momento para o usuário escolher.
 *  - Anexo PDF: devolve o texto extraído para virar base da matéria.
 *
 * Fica separado do router principal de propósito: o chat existente não muda.
 */
const express = require('express');
const { uploadChatDoc } = require('../middleware/uploadChatDoc');

const router = express.Router();

/** Quantos assuntos o radar devolve por vez. */
const LIMITE_TOPICOS = 20;

/**
 * Temas que abrem por padrão ao clicar em "Em alta".
 * Cada tema tem consultas próprias: buscar só "política" traz notícia genérica
 * (amamentação, futebol) que não serve para a Página. As variações amarram o
 * assunto ao universo evangélico/gospel, que é o nicho do produto.
 */
const TEMAS_PADRAO = Object.freeze([
  Object.freeze({
    rotulo: 'política',
    consultas: Object.freeze(['política evangélicos', 'bancada evangélica', 'deputado pastor']),
  }),
  Object.freeze({
    rotulo: 'igreja evangélica',
    consultas: Object.freeze(['igreja evangélica', 'pastor igreja evangélica', 'culto evangélico']),
  }),
  Object.freeze({
    rotulo: 'polêmica gospel',
    consultas: Object.freeze(['polêmica gospel', 'cantor gospel polêmica', 'cantora gospel']),
  }),
]);

/** Notícia em alta pesa mais que post de rede, que pesa mais que matéria comum. */
function pesoTipoFonte(item) {
  if (item.emAlta) return 4;
  if (item.tipoFonte === 'rede_social' || item.redeSocial) return 3;
  return 2;
}

/**
 * Junta o mesmo assunto publicado por vários veículos num único cartão.
 * Quanto mais veículos e sinais, maior o "calor".
 */
function agruparPorAssunto(itens, titulosSimilares) {
  const grupos = [];
  for (const item of itens) {
    const grupo = grupos.find((g) => titulosSimilares(g.principal.titulo, item.titulo));
    if (!grupo) {
      grupos.push({ principal: item, itens: [item] });
      continue;
    }
    grupo.itens.push(item);
    // Prefere notícia com resumo maior como cartão principal do grupo.
    const trocaPrincipal =
      item.tipoFonte !== 'rede_social' &&
      (grupo.principal.tipoFonte === 'rede_social' ||
        String(item.resumo || '').length > String(grupo.principal.resumo || '').length);
    if (trocaPrincipal) grupo.principal = item;
  }

  return grupos.map((g) => {
    const veiculos = new Set(
      g.itens.map((i) => String(i.veiculo || i.fonte || '').trim()).filter(Boolean)
    );
    const temRede = g.itens.some((i) => i.tipoFonte === 'rede_social' || i.redeSocial);
    const temTrend = g.itens.some((i) => i.emAlta);
    const calor =
      g.itens.reduce((soma, i) => soma + pesoTipoFonte(i), 0) +
      veiculos.size * 3 +
      (temTrend ? 5 : 0) +
      (temRede ? 2 : 0);

    return {
      ...g.principal,
      calor,
      contagemFontes: g.itens.length,
      veiculos: [...veiculos].slice(0, 5),
    };
  });
}

/**
 * Reparte as vagas entre os temas, em rodadas.
 * Sem isso o tema que devolve mais resultado ocupa a lista inteira.
 */
function distribuirPorTema(agrupados, rotulos, limite) {
  const filas = new Map(rotulos.map((r) => [r, []]));
  const sobra = [];
  for (const item of agrupados) {
    if (filas.has(item.tema)) filas.get(item.tema).push(item);
    else sobra.push(item);
  }

  const escolhidos = [];
  let rodou = true;
  while (escolhidos.length < limite && rodou) {
    rodou = false;
    for (const rotulo of rotulos) {
      if (escolhidos.length >= limite) break;
      const fila = filas.get(rotulo);
      if (!fila?.length) continue;
      escolhidos.push(fila.shift());
      rodou = true;
    }
  }
  // Faltou fechar a lista? Completa com o que sobrou, do mais quente para o menos.
  for (const item of sobra) {
    if (escolhidos.length >= limite) break;
    escolhidos.push(item);
  }
  return escolhidos;
}

/**
 * Radar por tema, reaproveitando os coletores já existentes no projeto.
 * Cada coletor é tolerante a falha: chave de API vencida não derruba o radar.
 */
async function radarPorTemas(temas, { horas = 24, limite = LIMITE_TOPICOS } = {}) {
  const nr = require('../services/newsResearch');
  const alvo = temas.slice(0, 5);
  const when = horas === 48 ? '2d' : '1d';

  // Cada busca carrega o tema de origem para a cota funcionar depois.
  const tarefas = [];
  const marcar = (tema, promessa) => tarefas.push({ tema, promessa });
  alvo.forEach((tema, indice) => {
    tema.consultas.slice(0, 3).forEach((consulta) => {
      marcar(tema.rotulo, nr.buscarGoogleNewsEmAlta(consulta));
      marcar(tema.rotulo, nr.buscarGoogleNewsRss(consulta, { when }));
      marcar(tema.rotulo, nr.buscarBraveNews(consulta, 1));
      // Redes sociais só na primeira consulta de cada tema: é a busca mais cara.
      if (indice < 3 && consulta === tema.consultas[0]) {
        marcar(tema.rotulo, nr.buscarSerperRedes(consulta));
      }
    });
  });

  const resultados = await Promise.allSettled(tarefas.map((t) => t.promessa));
  const bruto = [];
  resultados.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    for (const item of r.value) bruto.push({ ...item, tema: tarefas[i].tema });
  });

  const filtrados = nr.deduplicarTopicos(
    bruto.filter((i) => nr.itemEhRecente(i, { horas }) || i.emAlta)
  );

  const agrupados = agruparPorAssunto(filtrados, nr.titulosSimilares).sort(
    (a, b) => b.calor - a.calor
  );

  const escolhidos = distribuirPorTema(
    agrupados,
    alvo.map((t) => t.rotulo),
    limite
  );

  // Apuração extra é bônus e roda em paralelo: se falhar, o item cru já serve.
  const { apurarTopico } = require('../services/articleSource');
  const apurados = await Promise.allSettled(escolhidos.map((t) => apurarTopico(t)));
  const topicos = apurados.map((r, i) =>
    r.status === 'fulfilled' && r.value ? { ...r.value, tema: escolhidos[i].tema } : escolhidos[i]
  );

  return { topicos, totalAnalisado: filtrados.length, horas };
}

function limpar(valor, max) {
  return String(valor || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Radar de assuntos em alta agora.
 * Sem busca → abre nos temas padrão. Com busca → foca no que o usuário pediu.
 */
router.post('/em-alta', async (req, res, next) => {
  try {
    const body = req.body || {};
    const busca = limpar(body.busca || body.palavrasExtras || body.palavras_extras, 200);
    const horas = Number(body.horas) === 48 ? 48 : 24;

    const temasDaBusca = busca
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
      .slice(0, 5)
      .map((t) => ({ rotulo: t, consultas: [t] }));

    const usandoPadrao = temasDaBusca.length === 0;
    const temas = usandoPadrao ? TEMAS_PADRAO : temasDaBusca;

    const resultado = await radarPorTemas(temas, { horas, limite: LIMITE_TOPICOS });

    const topicos = (resultado.topicos || [])
      .filter((t) => t && t.titulo && (t.link || t.url))
      .map((t) => ({
        titulo: limpar(t.titulo, 300),
        url: String(t.link || t.url).trim().slice(0, 500),
        veiculo: limpar(t.veiculo || t.fonte || 'Web', 80),
        resumo: limpar(t.resumo || t.trecho, 320),
        tema: limpar(t.tema, 60) || null,
        contagemFontes: Number(t.contagemFontes) || 1,
        calor: Number(t.calor) || 0,
      }));

    return res.json({
      ok: true,
      horas,
      temas: temas.map((t) => t.rotulo),
      padrao: usandoPadrao,
      limite: LIMITE_TOPICOS,
      totalAnalisado: Number(resultado.totalAnalisado) || 0,
      topicos,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Anexo PDF. O arquivo não é guardado: o texto volta para o navegador,
 * que o envia junto da mensagem do chat.
 */
router.post('/anexos', (req, res, next) => {
  uploadChatDoc(req, res, async (uploadError) => {
    if (uploadError) {
      const mensagem =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'PDF muito grande. O limite é 15 MB.'
          : uploadError.message || 'Falha ao receber o arquivo';
      return res.status(uploadError.status || 400).json({ error: mensagem });
    }

    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Escolha um arquivo PDF para enviar.' });
      }
      const { extrairTextoDePdf } = require('../services/documentText');
      const doc = await extrairTextoDePdf(req.file.buffer);
      const nome = limpar(req.file.originalname || 'documento.pdf', 200) || 'documento.pdf';
      return res.json({ ok: true, anexo: { nome, ...doc } });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
});

module.exports = router;
module.exports.TEMAS_PADRAO = TEMAS_PADRAO;
module.exports.radarPorTemas = radarPorTemas;
module.exports.LIMITE_TOPICOS = LIMITE_TOPICOS;
