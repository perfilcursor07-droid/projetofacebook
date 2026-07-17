/**
 * Adiciona plataforma "site" na biblioteca (portais / últimas notícias).
 */
exports.up = async function up(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  await knex.raw(`
    ALTER TABLE biblioteca_fontes
    MODIFY COLUMN plataforma
    ENUM('youtube', 'facebook', 'instagram', 'tiktok', 'site', 'outro')
    NOT NULL DEFAULT 'outro'
  `);
};

exports.down = async function down(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  // posts já marcados como site voltam para outro
  await knex('biblioteca_fontes').where({ plataforma: 'site' }).update({ plataforma: 'outro' });
  await knex.raw(`
    ALTER TABLE biblioteca_fontes
    MODIFY COLUMN plataforma
    ENUM('youtube', 'facebook', 'instagram', 'tiktok', 'outro')
    NOT NULL DEFAULT 'outro'
  `);
};
