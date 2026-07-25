/**
 * Diagnóstico somente-leitura: mostra páginas, dono, padrão do usuário e se há
 * Profile Key da Ayrshare. Nunca imprime a chave inteira.
 *   node scripts/diag-pages.js
 */
require('dotenv').config();
const db = require('../src/config/db');

(async () => {
  const pages = await db('facebook_pages as p')
    .leftJoin('facebook_accounts as a', 'p.facebook_account_id', 'a.id')
    .select('p.id', 'p.page_name', 'p.ayrshare_profile_key', 'a.user_id');
  const users = await db('users').select('id', 'email', 'default_facebook_page_id');

  const keyCount = new Map();
  for (const p of pages) {
    const k = String(p.ayrshare_profile_key || '').trim();
    if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1);
  }

  console.log('--- Páginas ---');
  for (const p of pages) {
    const k = String(p.ayrshare_profile_key || '').trim();
    console.log(
      [
        `page#${p.id}`,
        `dono=user#${p.user_id ?? '?'}`,
        `nome=${p.page_name}`,
        `profileKey=${k ? `sim(${k.length} chars, ...${k.slice(-4)})` : 'NAO'}`,
        k && keyCount.get(k) > 1 ? 'ALERTA=key_duplicada' : '',
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }

  console.log('--- Usuários ---');
  for (const u of users) {
    const padrao = pages.find((p) => Number(p.id) === Number(u.default_facebook_page_id));
    console.log(
      [
        `user#${u.id}`,
        `email=${String(u.email || '').replace(/^(.).*(@.*)$/, '$1***$2')}`,
        `padrao=${u.default_facebook_page_id || 'NENHUMA'}`,
        padrao ? `padraoNome=${padrao.page_name}` : '',
        padrao && Number(padrao.user_id) !== Number(u.id) ? 'ALERTA=padrao_de_outro_usuario' : '',
        padrao && !String(padrao.ayrshare_profile_key || '').trim()
          ? 'ALERTA=padrao_sem_profile_key'
          : '',
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }

  await db.destroy();
})().catch(async (err) => {
  console.error('Falha no diagnóstico:', err.message);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
