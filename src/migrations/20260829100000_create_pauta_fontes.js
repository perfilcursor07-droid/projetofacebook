/**
 * Fontes configuráveis usadas por /materia-manual → Descobrir → Mais lidas.
 * O hash permite unicidade sem indexar a URL inteira em utf8mb4.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pauta_fontes')) return;

  await knex.schema.createTable('pauta_fontes', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('nome', 160).notNullable();
    table.string('url', 1000).notNullable();
    table.string('url_hash', 64).notNullable();
    table.enum('localizacao', ['pagina', 'home']).notNullable().defaultTo('pagina');
    table.string('marcador', 120).nullable();
    table.string('seletor_css', 300).nullable();
    table.integer('limite').unsigned().notNullable().defaultTo(10);
    table.boolean('ativa').notNullable().defaultTo(true);
    table.timestamp('ultimo_scan').nullable();
    table.integer('ultimo_total').unsigned().notNullable().defaultTo(0);
    table.text('ultimo_erro').nullable();
    table.timestamps(true, true);

    table.unique(['user_id', 'url_hash'], 'pauta_fontes_user_url_unique');
    table.index(['user_id', 'ativa']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pauta_fontes');
};
