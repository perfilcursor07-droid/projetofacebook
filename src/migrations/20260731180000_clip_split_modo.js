/**
 * Layout da tela dividida: lado a lado OU empilhado (imagem/vídeo em cima/baixo).
 */
exports.up = async function up(knex) {
  const hasModo = await knex.schema.hasColumn('video_clips', 'split_modo');
  const hasPos = await knex.schema.hasColumn('video_clips', 'split_imagem_pos');
  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasModo) {
      table.string('split_modo', 20).notNullable().defaultTo('lado');
    }
    if (!hasPos) {
      table.string('split_imagem_pos', 20).notNullable().defaultTo('esquerda');
    }
  });
};

exports.down = async function down(knex) {
  const hasModo = await knex.schema.hasColumn('video_clips', 'split_modo');
  const hasPos = await knex.schema.hasColumn('video_clips', 'split_imagem_pos');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasModo) table.dropColumn('split_modo');
    if (hasPos) table.dropColumn('split_imagem_pos');
  });
};
