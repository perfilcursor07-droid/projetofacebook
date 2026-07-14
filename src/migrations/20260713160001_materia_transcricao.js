/**
 * Campos de matéria / transcrição para clipes e imagens.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('video_clips', (table) => {
    table.text('transcricao').nullable();
    table
      .enum('materia_status', ['pendente', 'gerando', 'pronta', 'erro'])
      .notNullable()
      .defaultTo('pendente');
  });

  await knex.schema.alterTable('imagens', (table) => {
    table.text('materia').nullable();
    table.text('prompt_materia').nullable();
    table
      .enum('materia_status', ['pendente', 'gerando', 'pronta', 'erro'])
      .notNullable()
      .defaultTo('pendente');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('video_clips', (table) => {
    table.dropColumn('transcricao');
    table.dropColumn('materia_status');
  });

  await knex.schema.alterTable('imagens', (table) => {
    table.dropColumn('materia');
    table.dropColumn('prompt_materia');
    table.dropColumn('materia_status');
  });
};
