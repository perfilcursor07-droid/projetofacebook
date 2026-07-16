/**
 * Matérias do tipo Reel (vídeo FB/IG via /conteudo).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasVideoPath = await knex.schema.hasColumn('ai_matters', 'video_path');
  const hasClipId = await knex.schema.hasColumn('ai_matters', 'video_clip_id');

  await knex.schema.alterTable('ai_matters', (table) => {
    if (!hasVideoPath) table.string('video_path', 500).nullable();
    if (!hasClipId) {
      table
        .integer('video_clip_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('video_clips')
        .onDelete('SET NULL');
    }
  });

  // MySQL: amplia enum texto|foto → texto|foto|reel
  await knex.raw(
    "ALTER TABLE `ai_matters` MODIFY COLUMN `tipo_publicacao` ENUM('texto','foto','reel') NOT NULL DEFAULT 'texto'"
  );
  await knex.raw(
    "ALTER TABLE `ai_monitors` MODIFY COLUMN `tipo_publicacao` ENUM('texto','foto','reel') NOT NULL DEFAULT 'texto'"
  );
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex('ai_matters').where({ tipo_publicacao: 'reel' }).update({ tipo_publicacao: 'texto' });
  await knex('ai_monitors').where({ tipo_publicacao: 'reel' }).update({ tipo_publicacao: 'foto' });

  await knex.raw(
    "ALTER TABLE `ai_matters` MODIFY COLUMN `tipo_publicacao` ENUM('texto','foto') NOT NULL DEFAULT 'texto'"
  );
  await knex.raw(
    "ALTER TABLE `ai_monitors` MODIFY COLUMN `tipo_publicacao` ENUM('texto','foto') NOT NULL DEFAULT 'foto'"
  );

  const hasVideoPath = await knex.schema.hasColumn('ai_matters', 'video_path');
  const hasClipId = await knex.schema.hasColumn('ai_matters', 'video_clip_id');
  await knex.schema.alterTable('ai_matters', (table) => {
    if (hasClipId) table.dropColumn('video_clip_id');
    if (hasVideoPath) table.dropColumn('video_path');
  });
};
