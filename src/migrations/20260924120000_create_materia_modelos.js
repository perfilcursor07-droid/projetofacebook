/**
 * Modelos do Token-Free Gateway que o administrador libera para escrever
 * no /materia-manual. O editor só pode escolher entre os habilitados.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('materia_modelos');
  if (exists) return;
  await knex.schema.createTable('materia_modelos', (table) => {
    table.increments('id').primary();
    table.string('modelo', 120).notNullable().unique();
    table.boolean('habilitado').notNullable().defaultTo(true);
    table.boolean('padrao').notNullable().defaultTo(false);
    table.timestamps(true, true);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('materia_modelos');
};
