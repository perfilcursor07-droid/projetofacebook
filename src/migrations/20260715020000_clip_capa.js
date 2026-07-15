/**
 * Capa de marca no início do corte (imagem + título antes do vídeo).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasTitulo = await knex.schema.hasColumn('video_clips', 'capa_titulo');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_capa');
  const hasStatus = await knex.schema.hasColumn('video_clips', 'capa_status');

  await knex.schema.alterTable('video_clips', (table) => {
    if (!hasTitulo) table.string('capa_titulo', 300).nullable();
    if (!hasArquivo) table.string('arquivo_sem_capa', 500).nullable();
    if (!hasStatus) {
      table
        .enum('capa_status', ['pendente', 'gerando', 'pronta', 'erro'])
        .notNullable()
        .defaultTo('pendente');
    }
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasTitulo = await knex.schema.hasColumn('video_clips', 'capa_titulo');
  const hasArquivo = await knex.schema.hasColumn('video_clips', 'arquivo_sem_capa');
  const hasStatus = await knex.schema.hasColumn('video_clips', 'capa_status');

  await knex.schema.alterTable('video_clips', (table) => {
    if (hasTitulo) table.dropColumn('capa_titulo');
    if (hasArquivo) table.dropColumn('arquivo_sem_capa');
    if (hasStatus) table.dropColumn('capa_status');
  });
};
