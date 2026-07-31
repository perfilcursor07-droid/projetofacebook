/**
 * Velocidade de reprodução do corte (1x = normal; 2x = metade da duração, etc.).
 */
exports.up = async function up(knex) {
  const hasSpeed = await knex.schema.hasColumn('video_clips', 'playback_speed');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_speed');
  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasSpeed) table.decimal('playback_speed', 4, 2).notNullable().defaultTo(1);
    if (!hasArquivo) table.string('arquivo_sem_speed', 500).nullable();
  });
};

exports.down = async function down(knex) {
  const hasSpeed = await knex.schema.hasColumn('video_clips', 'playback_speed');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_speed');
  await knex.schema.alterTable('video_clips', (table) => {
    if (hasSpeed) table.dropColumn('playback_speed');
    if (hasArquivo) table.dropColumn('arquivo_sem_speed');
  });
};
