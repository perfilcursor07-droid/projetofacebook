/**
 * Links salvos em /conteudo (Radar Face + A partir do link).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('conteudo_links');
  if (exists) return;

  await knex.schema.createTable('conteudo_links', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('nome', 200).notNullable();
    table.string('url', 1500).notNullable();
    table
      .enum('tipo', ['pagina', 'post', 'reel', 'noticia', 'outro'])
      .notNullable()
      .defaultTo('outro');
    table.string('notas', 500).nullable();
    table.timestamps(true, true);

    table.unique(['user_id', 'url']);
    table.index(['user_id', 'created_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('conteudo_links');
};
