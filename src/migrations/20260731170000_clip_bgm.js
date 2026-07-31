/**
 * Música de fundo no corte (preset + volume + backup sem BGM).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasPreset = await knex.schema.hasColumn('video_clips', 'bgm_preset');
  const hasVol = await knex.schema.hasColumn('video_clips', 'bgm_volume');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_bgm');

  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasPreset) table.string('bgm_preset', 20).notNullable().defaultTo('nenhuma');
    if (!hasVol) table.integer('bgm_volume').notNullable().defaultTo(18);
    if (!hasArquivo) table.string('arquivo_sem_bgm', 500).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasPreset = await knex.schema.hasColumn('video_clips', 'bgm_preset');
  const hasVol = await knex.schema.hasColumn('video_clips', 'bgm_volume');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_bgm');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasPreset) table.dropColumn('bgm_preset');
    if (hasVol) table.dropColumn('bgm_volume');
    if (hasArquivo) table.dropColumn('arquivo_sem_bgm');
  });
};
