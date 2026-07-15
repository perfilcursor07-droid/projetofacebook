/**
 * Capa de marca no início do corte (imagem + título antes do vídeo).
 * - capa_titulo: título usado na arte
 * - arquivo_sem_capa: backup do corte original para refazer/remover a capa
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('video_clips', (table) => {
    table.string('capa_titulo', 300).nullable();
    table.string('arquivo_sem_capa', 500).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('video_clips', (table) => {
    table.dropColumn('capa_titulo');
    table.dropColumn('arquivo_sem_capa');
  });
};
