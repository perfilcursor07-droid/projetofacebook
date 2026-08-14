#!/usr/bin/env node
/**
 * Diagnóstico da listagem de posts de uma página do Facebook pela sessão
 * (YTDLP_FB_COOKIES_FILE). Não imprime cookies.
 *
 * Uso:
 *   node scripts/test-fb-page.js "https://www.facebook.com/DavidJHarrisJr"
 *   node scripts/test-fb-page.js "https://www.facebook.com/DavidJHarrisJr" --dump
 *
 * --dump grava o HTML autenticado em /tmp para inspecionar padrões novos.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { diagnoseFacebookCookies } = require('../src/services/facebookCookies');
const {
  isConfigured,
  baixarHtmlPagina,
  extrairPostsDoHtml,
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
  if (!isConfigured()) {
    console.log('FAIL: sessão do Facebook não configurada — veja YTDLP_FB_COOKIES_FILE.');
    process.exit(2);
  }

  console.log('Página:', PAGE);
  const { html, finalUrl, status } = await baixarHtmlPagina(PAGE);
  console.log('Resposta:', { status, finalUrl: finalUrl.slice(0, 120), len: html.length });

  if (DUMP) {
    const out = path.join(os.tmpdir(), `fb-page-${Date.now()}.html`);
    fs.writeFileSync(out, html);
    console.log('HTML salvo em:', out);
  }

  // Contagens brutas ajudam a saber QUAL padrão falhou quando dá 0 posts.
  const padroes = {
    wwwURL: /"wwwURL"\s*:\s*"/g,
    url_json: /"url"\s*:\s*"https:[^"]*facebook\.com/g,
    permalink_url: /"permalink_url"\s*:\s*"/g,
    message_text: /"message"\s*:\s*\{\s*"text"\s*:/g,
    story_fbid: /story_fbid/g,
    posts_path: /\\?\/posts\\?\//g,
    pfbid: /pfbid[A-Za-z0-9]{20,}/g,
    creation_time: /"creation_time"\s*:\s*\d{9,13}/g,
    scontent: /"uri"\s*:\s*"https:[^"]*scontent/g,
  };
  console.log('Ocorrências por padrão:');
  for (const [nome, re] of Object.entries(padroes)) {
    console.log(`  ${nome}: ${(html.match(re) || []).length}`);
  }

  const { itens, sinais } = extrairPostsDoHtml(html, 20);
  console.log('Sinais:', sinais);
  console.log(`Posts extraídos: ${itens.length}`);
  for (const item of itens.slice(0, 5)) {
    console.log('  -', {
      url: String(item.url).slice(0, 90),
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
