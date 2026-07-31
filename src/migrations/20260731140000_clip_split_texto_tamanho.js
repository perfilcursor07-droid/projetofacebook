/**
 * Tamanho da fonte do texto fixo na tela dividida (percentual do tamanho padrão).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('video_clips', 'split_texto_tamanho');
  if (has) return;
  await knex.schema.alterTable('video_clips', (table) => {
    table.integer('split_texto_tamanho').notNullable().defaultTo(100);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('video_clips', 'split_texto_tamanho');
  if (!has) return;
  await knex.schema.alterTable('video_clips', (table) => {
    table.dropColumn('split_texto_tamanho');
  });
};
