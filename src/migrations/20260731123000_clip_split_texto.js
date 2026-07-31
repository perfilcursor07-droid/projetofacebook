/**
 * Texto fixo opcional na tela dividida (topo ou rodapé), após a capa.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasTexto = await knex.schema.hasColumn('video_clips', 'split_texto');
  const hasPos = await knex.schema.hasColumn('video_clips', 'split_texto_posicao');

  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasTexto) table.string('split_texto', 500).nullable();
    if (!hasPos) {
      table
        .enum('split_texto_posicao', ['topo', 'rodape'])
        .notNullable()
        .defaultTo('rodape');
    }
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasTexto = await knex.schema.hasColumn('video_clips', 'split_texto');
  const hasPos = await knex.schema.hasColumn('video_clips', 'split_texto_posicao');

  await knex.schema.alterTable('video_clips', (table) => {
    if (hasTexto) table.dropColumn('split_texto');
    if (hasPos) table.dropColumn('split_texto_posicao');
  });
};
