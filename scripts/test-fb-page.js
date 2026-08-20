#!/usr/bin/env node
/**
 * Diagnóstico da listagem de posts de uma página do Facebook pela sessão
 * (YTDLP_FB_COOKIES_FILE). Não imprime cookies.
 *
 * Uso:
 *   node scripts/test-fb-page.js "https://www.facebook.com/DavidJHarrisJr"
 *   node scripts/test-fb-page.js "https://www.facebook.com/DavidJHarrisJr" --dump
 *
 * --dump grava o HTML da página em /tmp para inspecionar padrões novos.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { diagnoseFacebookCookies } = require('../src/services/facebookCookies');
const {
  isConfigured,
  baixarHtmlPagina,
  extrairUrlsDePosts,
  extrairDetalhesDoPost,
  listarPostsPerfil,
  listarPostsViaPlugin,
  variantesDaPagina,
} = require('../src/services/facebookPageScrape');

const PAGE = process.argv[2];
const DUMP = process.argv.includes('--dump');

(async () => {
  if (!PAGE) {
    console.log('Informe a URL da página. Ex.: node scripts/test-fb-page.js "https://www.facebook.com/newsgospelng"');
    process.exit(2);
  }

  console.log('=== Diagnóstico listagem de página do Facebook ===');
  const diag = diagnoseFacebookCookies();
  console.log('Cookies:', { ok: diag.ok, reason: diag.reason, file: diag.file });
  console.log('Página:', PAGE);

  console.log('\nFeed público oficial (sem API paga):');
  const pluginItens = await listarPostsViaPlugin(PAGE, 40).catch((err) => {
    console.log('  ERRO:', err.message);
    return [];
  });
  console.log(`  Itens aproveitáveis: ${pluginItens.length}`);
  for (const item of pluginItens.slice(0, 5)) {
    console.log('  -', {
      titulo: String(item.titulo).slice(0, 60),
      temThumb: Boolean(item.thumbnail),
      publicadoEm: item.publicadoEm ? item.publicadoEm.toISOString().slice(0, 10) : null,
    });
  }

  if (!isConfigured()) {
    console.log('Sessão não configurada; o feed público acima continua disponível.');
    process.exit(pluginItens.length ? 0 : 2);
  }

  const { html, finalUrl, status } = await baixarHtmlPagina(PAGE);
  console.log('Resposta:', { status, finalUrl: finalUrl.slice(0, 120), len: html.length });

  if (DUMP) {
    const out = path.join(os.tmpdir(), `fb-page-${Date.now()}.html`);
    fs.writeFileSync(out, html);
    console.log('HTML salvo em:', out);
  }

  // Etapa 1: permalinks na página (o texto NÃO vem aqui — carrega por GraphQL).
  const { urls, sinais } = extrairUrlsDePosts(html);
  console.log('Links por padrão:', sinais.porPadrao);
  console.log(`Permalinks únicos (página principal): ${urls.length}`);
  for (const u of urls.slice(0, 8)) console.log('  -', u.slice(0, 100));

  // Quanto cada variante acrescenta — mostra se vale manter as três.
  console.log('\nRendimento por variante:');
  const acumulado = new Set(urls.map((u) => u.toLowerCase()));
  for (const variante of variantesDaPagina(PAGE).slice(1)) {
    try {
      const r = await baixarHtmlPagina(variante);
      const achados = extrairUrlsDePosts(r.html).urls;
      const novos = achados.filter((u) => !acumulado.has(u.toLowerCase()));
      novos.forEach((u) => acumulado.add(u.toLowerCase()));
      console.log(`  ${variante.replace('https://www.facebook.com', '')}: ${achados.length} links (${novos.length} inéditos)`);
    } catch (err) {
      console.log(`  ${variante.replace('https://www.facebook.com', '')}: ERRO ${err.message}`);
    }
  }
  console.log(`  => total único somando variantes: ${acumulado.size}`);

  if (!urls.length) {
    console.log('FAIL: nenhum permalink encontrado — rode com --dump e me mande o HTML.');
    process.exit(1);
  }

  // Etapa 2: abrir 1 post para conferir que o texto vem renderizado.
  console.log('\nAmostra do primeiro post:');
  const amostra = await baixarHtmlPagina(urls[0]);
  const detalhe = extrairDetalhesDoPost(amostra.html);
  console.log({
    url: urls[0].slice(0, 90),
    len: amostra.html.length,
    textoLen: detalhe.texto?.length || 0,
    textoPreview: String(detalhe.texto || '').slice(0, 80),
    temImagem: Boolean(detalhe.imagem),
    publicadoEm: detalhe.publicadoEm ? detalhe.publicadoEm.toISOString().slice(0, 16) : null,
  });

  // Fluxo completo, igual ao que a Biblioteca executa.
  console.log('\nlistarPostsPerfil (fluxo real):');
  const itens = await listarPostsPerfil(PAGE, 25);
  console.log(`Itens aproveitáveis: ${itens.length}`);
  for (const item of itens.slice(0, 5)) {
    console.log('  -', {
      titulo: String(item.titulo).slice(0, 60),
      temResumo: Boolean(item.resumo),
      temThumb: Boolean(item.thumbnail),
      publicadoEm: item.publicadoEm ? item.publicadoEm.toISOString().slice(0, 10) : null,
    });
  }

  process.exit(itens.length ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(1);
});
