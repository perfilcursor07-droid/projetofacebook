/**
 * Garante capa_status mesmo se a migração anterior já tiver sido aplicada sem essa coluna.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasStatus = await knex.schema.hasColumn('video_clips', 'capa_status');
  if (hasStatus) return;
  await knex.schema.alterTable('video_clips', (table) => {
    table
      .enum('capa_status', ['pendente', 'gerando', 'pronta', 'erro'])
      .notNullable()
      .defaultTo('pendente');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasStatus = await knex.schema.hasColumn('video_clips', 'capa_status');
  if (!hasStatus) return;
  await knex.schema.alterTable('video_clips', (table) => {
    table.dropColumn('capa_status');
  });
};
