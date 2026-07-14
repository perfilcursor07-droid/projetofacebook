/**
 * Adiciona tipo de publicação (reel, video, foto, texto) e o texto do post,
 * permitindo posts somente de texto (sem clipe nem imagem).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('publications', (table) => {
    table
      .enum('tipo', ['reel', 'video', 'foto', 'texto'])
      .notNullable()
      .defaultTo('video');
    table.text('texto').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('publications', (table) => {
    table.dropColumn('tipo');
    table.dropColumn('texto');
  });
};
