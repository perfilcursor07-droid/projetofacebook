/**
 * Persiste o modelo visual da marca e o modelo usado em cada arte.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('marca_modelo_arte', 40).notNullable().defaultTo('faixa_classica');
  });

  await knex.schema.alterTable('ai_matters', (table) => {
    table.string('arte_modelo', 40).nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('ai_matters', (table) => {
    table.dropColumn('arte_modelo');
  });

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('marca_modelo_arte');
  });
};