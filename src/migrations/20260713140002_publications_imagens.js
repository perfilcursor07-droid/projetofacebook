/**
 * Permite publicações de imagens além de clipes de vídeo.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('publications', (table) => {
    table.integer('video_clip_id').unsigned().nullable().alter();
    table
      .integer('imagem_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('imagens')
      .onDelete('CASCADE');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('publications', (table) => {
    table.dropForeign('imagem_id');
    table.dropColumn('imagem_id');
    table.integer('video_clip_id').unsigned().notNullable().alter();
  });
};
