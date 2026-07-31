/**
 * Zoom independente (mostrar mais / aproximar) no enquadramento da tela dividida.
 */
exports.up = async function up(knex) {
  const hasVid = await knex.schema.hasColumn('video_clips', 'split_video_zoom');
  const hasImg = await knex.schema.hasColumn('video_clips', 'split_image_zoom');
  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasVid) table.integer('split_video_zoom').notNullable().defaultTo(100);
    if (!hasImg) table.integer('split_image_zoom').notNullable().defaultTo(100);
  });
};

exports.down = async function down(knex) {
  const hasVid = await knex.schema.hasColumn('video_clips', 'split_video_zoom');
  const hasImg = await knex.schema.hasColumn('video_clips', 'split_image_zoom');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasVid) table.dropColumn('split_video_zoom');
    if (hasImg) table.dropColumn('split_image_zoom');
  });
};
