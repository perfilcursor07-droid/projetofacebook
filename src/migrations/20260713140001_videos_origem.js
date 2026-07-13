/**
 * Generaliza a tabela videos para aceitar outras origens além da Pexels:
 * upload local e importação por link (YouTube/TikTok/URL direta).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('videos', (table) => {
    table
      .enum('origem', ['pexels', 'upload', 'link'])
      .notNullable()
      .defaultTo('pexels');
    table.string('titulo', 500).nullable();
    table.string('pexels_id', 64).nullable().alter();
    table.text('url_original').nullable().alter();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('videos', (table) => {
    table.dropColumn('origem');
    table.dropColumn('titulo');
    table.string('pexels_id', 64).notNullable().alter();
    table.text('url_original').notNullable().alter();
  });
};
