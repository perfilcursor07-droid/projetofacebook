/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('video_clips', (table) => {
    table.increments('id').primary();
    table
      .integer('video_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('videos')
      .onDelete('CASCADE');
    table.decimal('inicio_segundo', 10, 2).notNullable();
    table.decimal('fim_segundo', 10, 2).notNullable();
    table.string('caminho_arquivo', 500).nullable();
    table.text('legenda_sugerida').nullable();
    table
      .enum('status', ['sugerido', 'processando', 'pronto', 'publicado', 'erro'])
      .notNullable()
      .defaultTo('sugerido');
    table.string('aspect_ratio', 10).nullable().defaultTo('9:16');
    table.text('erro_mensagem').nullable();
    table.timestamps(true, true);

    table.index(['video_id', 'status']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('video_clips');
};
