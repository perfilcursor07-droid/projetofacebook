/**
 * Fila de pré-agendamento da Biblioteca (dia seguinte, meia em meia hora).
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('biblioteca_agenda');
  if (exists) return;

  await knex.schema.createTable('biblioteca_agenda', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table
      .integer('facebook_page_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('SET NULL');
    table
      .integer('post_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('biblioteca_posts')
      .onDelete('CASCADE');
    table
      .integer('matter_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('ai_matters')
      .onDelete('SET NULL');
    table.timestamp('proposed_at').notNullable();
    table
      .string('status', 32)
      .notNullable()
      .defaultTo('pendente'); // pendente | confirmado | publicado | cancelado
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
    table.index(['user_id', 'proposed_at']);
    table.unique(['user_id', 'post_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('biblioteca_agenda');
};
