/**
 * Piloto automático da Biblioteca: N matérias a cada X minutos (opt-in).
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('biblioteca_autopilot');
  if (exists) return;

  await knex.schema.createTable('biblioteca_autopilot', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .unique()
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
    table.boolean('ativo').notNullable().defaultTo(false);
    table.integer('intervalo_minutos').unsigned().notNullable().defaultTo(30);
    table.integer('posts_por_ciclo').unsigned().notNullable().defaultTo(1);
    table.enum('tipo_publicacao', ['texto', 'foto']).notNullable().defaultTo('foto');
    table.timestamp('ultimo_tick').nullable();
    table.timestamp('proxima_execucao').nullable();
    table.integer('total_publicados').unsigned().notNullable().defaultTo(0);
    table.text('ultimo_erro').nullable();
    table.timestamps(true, true);

    table.index(['ativo', 'proxima_execucao']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('biblioteca_autopilot');
};
