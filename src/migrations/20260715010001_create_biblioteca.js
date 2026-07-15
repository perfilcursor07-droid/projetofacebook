/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('biblioteca_fontes', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .enum('plataforma', ['youtube', 'facebook', 'instagram', 'tiktok', 'outro'])
      .notNullable()
      .defaultTo('outro');
    table.string('nome', 200).notNullable();
    table.string('url', 500).notNullable();
    table.string('handle', 200).nullable();
    table.string('avatar_url', 1000).nullable();
    table.text('notas').nullable();
    table.boolean('monitorar').notNullable().defaultTo(false);
    table.integer('intervalo_minutos').unsigned().notNullable().defaultTo(60);
    table
      .integer('facebook_page_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('SET NULL');
    table.timestamp('ultimo_scan').nullable();
    table.timestamp('proxima_execucao').nullable();
    table.string('ultimo_external_id', 300).nullable();
    table.text('ultimo_erro').nullable();
    table.integer('total_detectados').unsigned().notNullable().defaultTo(0);
    table.timestamps(true, true);

    table.index(['user_id', 'monitorar']);
    table.index(['user_id', 'plataforma']);
    table.unique(['user_id', 'url'], 'biblioteca_fontes_user_url_unique');
  });

  await knex.schema.createTable('biblioteca_posts', (table) => {
    table.increments('id').primary();
    table
      .integer('fonte_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('biblioteca_fontes')
      .onDelete('CASCADE');
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('external_id', 300).nullable();
    table.string('titulo', 500).nullable();
    table.string('url', 500).notNullable();
    table.text('resumo').nullable();
    table.string('thumbnail', 1000).nullable();
    table.timestamp('publicado_em').nullable();
    table
      .enum('status', ['novo', 'visto', 'gerado_texto', 'gerado_video', 'ignorado'])
      .notNullable()
      .defaultTo('novo');
    table
      .integer('matter_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('ai_matters')
      .onDelete('SET NULL');
    table
      .integer('video_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('videos')
      .onDelete('SET NULL');
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
    table.index(['fonte_id', 'created_at']);
    table.unique(['fonte_id', 'external_id'], 'biblioteca_posts_fonte_ext_unique');
  });

  await knex.schema.createTable('biblioteca_alertas', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .integer('fonte_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('biblioteca_fontes')
      .onDelete('CASCADE');
    table
      .integer('post_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('biblioteca_posts')
      .onDelete('CASCADE');
    table.string('titulo', 300).notNullable();
    table.text('resumo').nullable();
    table.boolean('lido').notNullable().defaultTo(false);
    table.timestamps(true, true);

    table.index(['user_id', 'lido', 'created_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('biblioteca_alertas');
  await knex.schema.dropTableIfExists('biblioteca_posts');
  await knex.schema.dropTableIfExists('biblioteca_fontes');
};
