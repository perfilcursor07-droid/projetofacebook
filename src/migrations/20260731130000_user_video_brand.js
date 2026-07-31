/**
 * Marca de vídeo (Reels) independente da marca de arte/imagem.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasModelo = await knex.schema.hasColumn('users', 'marca_video_modelo');
  const hasCor = await knex.schema.hasColumn('users', 'marca_video_cor_destaque');

  await knex.schema.alterTable('users', (table) => {
    if (!hasModelo) {
      table.string('marca_video_modelo', 40).notNullable().defaultTo('faixa_rodape');
    }
    if (!hasCor) {
      // Cor das caixas de destaque (ex.: amarelo do thumbnail viral)
      table.string('marca_video_cor_destaque', 7).notNullable().defaultTo('#facc15');
    }
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasModelo = await knex.schema.hasColumn('users', 'marca_video_modelo');
  const hasCor = await knex.schema.hasColumn('users', 'marca_video_cor_destaque');

  await knex.schema.alterTable('users', (table) => {
    if (hasModelo) table.dropColumn('marca_video_modelo');
    if (hasCor) table.dropColumn('marca_video_cor_destaque');
  });
};
