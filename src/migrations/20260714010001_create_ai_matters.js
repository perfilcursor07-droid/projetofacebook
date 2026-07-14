/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('ai_matters', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .integer('facebook_page_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('SET NULL');
    table.string('titulo', 300).nullable();
    table.text('materia').nullable();
    table.json('hashtags').nullable();
    table.string('fonte_titulo', 500).nullable();
    table.string('fonte_url', 1000).nullable();
    table.text('fonte_resumo').nullable();
    table.text('contexto_apuracao').nullable();
    table
      .enum('status', ['rascunho', 'pronto', 'agendado', 'publicado', 'erro'])
      .notNullable()
      .defaultTo('rascunho');
    table.enum('tipo_publicacao', ['texto', 'foto']).notNullable().defaultTo('texto');
    table.string('imagem_path', 500).nullable();
    table.string('imagem_url', 1000).nullable();
    table
      .integer('publication_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('publications')
      .onDelete('SET NULL');
    table.timestamp('scheduled_at').nullable();
    table.timestamp('published_at').nullable();
    table.text('error_message').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
    table.index(['facebook_page_id']);
  });

  await knex.schema.createTable('ai_monitors', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .integer('facebook_page_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('CASCADE');
    table.string('palavras_chave', 500).notNullable();
    table.integer('intervalo_minutos').unsigned().notNullable().defaultTo(30);
    table.integer('posts_por_ciclo').unsigned().notNullable().defaultTo(1);
    table.enum('tipo_publicacao', ['texto', 'foto']).notNullable().defaultTo('texto');
    table.boolean('ativo').notNullable().defaultTo(true);
    table.timestamp('inicio_em').nullable();
    table.timestamp('fim_em').nullable();
    table.timestamp('ultimo_tick').nullable();
    table.timestamp('proxima_execucao').nullable();
    table.integer('total_publicados').unsigned().notNullable().defaultTo(0);
    table.text('ultimo_erro').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'ativo']);
  });

  await knex.schema.createTable('ai_fila_jobs', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .integer('matter_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('ai_matters')
      .onDelete('CASCADE');
    table.json('payload').nullable();
    table.timestamp('run_at').notNullable();
    table
      .enum('status', ['pendente', 'processando', 'feito', 'erro', 'cancelado'])
      .notNullable()
      .defaultTo('pendente');
    table.integer('attempts').unsigned().notNullable().defaultTo(0);
    table.text('erro').nullable();
    table.timestamps(true, true);

    table.index(['status', 'run_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_fila_jobs');
  await knex.schema.dropTableIfExists('ai_monitors');
  await knex.schema.dropTableIfExists('ai_matters');
};
