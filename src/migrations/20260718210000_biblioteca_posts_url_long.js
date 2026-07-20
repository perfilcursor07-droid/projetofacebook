/**
 * URLs do Google News / RSS podem passar de 500 chars.
 * external_id continua 191 (unique utf8mb4) — IDs longos viram hash no código.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.text('url').notNullable().alter();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.string('url', 500).notNullable().alter();
  });
};
