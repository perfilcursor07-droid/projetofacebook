/**
 * Fundo do texto no split: transparente ou com cor.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasFundo = await knex.schema.hasColumn('video_clips', 'split_texto_fundo');
  const hasCor = await knex.schema.hasColumn('video_clips', 'split_texto_fundo_cor');

  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasFundo) {
      table.string('split_texto_fundo', 20).notNullable().defaultTo('cor');
    }
    if (!hasCor) {
      table.string('split_texto_fundo_cor', 7).notNullable().defaultTo('#000000');
    }
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasFundo = await knex.schema.hasColumn('video_clips', 'split_texto_fundo');
  const hasCor = await knex.schema.hasColumn('video_clips', 'split_texto_fundo_cor');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasFundo) table.dropColumn('split_texto_fundo');
    if (hasCor) table.dropColumn('split_texto_fundo_cor');
  });
};
