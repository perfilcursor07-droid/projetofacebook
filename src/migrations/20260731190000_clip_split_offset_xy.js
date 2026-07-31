/**
 * Offset vertical independente no enquadramento da tela dividida
 * (além do horizontal já existente em split_*_offset).
 */
exports.up = async function up(knex) {
  const hasVidY = await knex.schema.hasColumn('video_clips', 'split_video_offset_y');
  const hasImgY = await knex.schema.hasColumn('video_clips', 'split_image_offset_y');
  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasVidY) {
      table.decimal('split_video_offset_y', 5, 2).notNullable().defaultTo(50);
    }
    if (!hasImgY) {
      table.decimal('split_image_offset_y', 5, 2).notNullable().defaultTo(50);
    }
  });
};

exports.down = async function down(knex) {
  const hasVidY = await knex.schema.hasColumn('video_clips', 'split_video_offset_y');
  const hasImgY = await knex.schema.hasColumn('video_clips', 'split_image_offset_y');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasVidY) table.dropColumn('split_video_offset_y');
    if (hasImgY) table.dropColumn('split_image_offset_y');
  });
};
