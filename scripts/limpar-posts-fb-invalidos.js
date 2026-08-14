#!/usr/bin/env node
/**
 * Remove da Biblioteca os posts de Facebook que na verdade não são posts
 * (perfis de comentaristas, telas de login, listagens /photos). Eles foram
 * gravados por scans antigos, antes do filtro estrito de permalink.
 *
 * DRY-RUN por padrão: só lista. Para apagar de fato, use --apply.
 *
 *   node scripts/limpar-posts-fb-invalidos.js
 *   node scripts/limpar-posts-fb-invalidos.js --apply
 *
 * Segurança: nunca remove post já convertido em matéria (matter_id) nem post
 * com status diferente de "novo".
 */
require('dotenv').config();

const db = require('../src/config/db');
const { ehUrlDePostValida } = require('../src/services/facebookPageScrape');

const APLICAR = process.argv.includes('--apply');

(async () => {
  console.log(`=== Limpeza de posts inválidos do Facebook (${APLICAR ? 'APLICAR' : 'DRY-RUN'}) ===`);

  const posts = await db('biblioteca_posts as p')
    .join('biblioteca_fontes as f', 'f.id', 'p.fonte_id')
    .where('f.plataforma', 'facebook')
    .select('p.id', 'p.titulo', 'p.url', 'p.status', 'p.matter_id', 'f.nome as fonte');

  console.log(`Posts de fontes Facebook: ${posts.length}`);

  const invalidos = [];
  const protegidos = [];
  for (const post of posts) {
    if (ehUrlDePostValida(post.url)) continue;
    if (post.matter_id || String(post.status || '').toLowerCase() !== 'novo') {
      protegidos.push(post);
      continue;
    }
    invalidos.push(post);
  }

  if (protegidos.length) {
    console.log(`\nIgnorados por segurança (já viraram matéria ou não estão "novo"): ${protegidos.length}`);
    for (const p of protegidos.slice(0, 10)) {
      console.log(`  [${p.id}] ${String(p.titulo || '').slice(0, 50)} — status=${p.status} matter=${p.matter_id || '-'}`);
    }
  }

  console.log(`\nCandidatos a remoção: ${invalidos.length}`);
  for (const p of invalidos) {
    console.log(`  [${p.id}] (${p.fonte}) ${String(p.titulo || '').slice(0, 45)}`);
    console.log(`         ${String(p.url).slice(0, 100)}`);
  }

  if (!invalidos.length) {
    console.log('\nNada a remover.');
    await db.destroy();
    return;
  }

  if (!APLICAR) {
    console.log('\nDRY-RUN: nada foi apagado. Rode de novo com --apply para remover os itens acima.');
    await db.destroy();
    return;
  }

  const ids = invalidos.map((p) => p.id);
  const removidos = await db('biblioteca_posts').whereIn('id', ids).del();
  console.log(`\n${removidos} post(s) removido(s).`);

  // total_detectados fica inflado pelos itens removidos.
  const fontes = await db('biblioteca_fontes').where('plataforma', 'facebook').select('id');
  for (const f of fontes) {
    const { total } = await db('biblioteca_posts').where('fonte_id', f.id).count({ total: '*' }).first();
    await db('biblioteca_fontes').where('id', f.id).update({ total_detectados: Number(total) || 0 });
  }
  console.log('Contadores das fontes recalculados.');

  await db.destroy();
})().catch(async (err) => {
  console.error('FATAL', err.message);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
