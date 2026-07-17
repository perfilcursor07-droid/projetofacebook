/**
 * Tipografia da marca: fonte, cor e tamanho do título nas artes.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('marca_fonte', 40).notNullable().defaultTo('serithai_condensed');
    table.string('marca_titulo_cor', 20).notNullable().defaultTo('branco');
    table.integer('marca_titulo_tamanho').unsigned().notNullable().defaultTo(43);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('marca_fonte');
    table.dropColumn('marca_titulo_cor');
    table.dropColumn('marca_titulo_tamanho');
  });
};
