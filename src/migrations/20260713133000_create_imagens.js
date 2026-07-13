/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('imagens', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('termo_busca', 255).notNullable();
    table.string('pexels_id', 64).notNullable();
    table.text('url_original').notNullable();
    table.text('thumbnail').nullable();
    table.integer('largura').unsigned().nullable();
    table.integer('altura').unsigned().nullable();
    table.string('autor', 255).nullable();
    table.string('autor_url', 500).nullable();
    table
      .enum('status', ['pendente', 'baixado', 'publicado', 'erro'])
      .notNullable()
      .defaultTo('pendente');
    table.string('caminho_local', 500).nullable();
    table.text('erro_mensagem').nullable();
    table.json('metadata').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
    table.index(['pexels_id']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('imagens');
};
