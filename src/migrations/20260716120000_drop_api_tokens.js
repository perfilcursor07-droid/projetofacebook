/**
 * Remove tokens da extensão de navegador (recurso descontinuado).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.dropTableIfExists('api_tokens');
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  if (await knex.schema.hasTable('api_tokens')) return;

  await knex.schema.createTable('api_tokens', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('token_hash', 64).notNullable().unique();
    table.string('nome_dispositivo', 150).notNullable().defaultTo('Extensão');
    table.timestamp('criado_em').notNullable().defaultTo(knex.fn.now());
    table.timestamp('ultimo_uso_em').nullable();
    table.timestamp('revogado_em').nullable();

    table.index(['user_id', 'revogado_em']);
  });
};
