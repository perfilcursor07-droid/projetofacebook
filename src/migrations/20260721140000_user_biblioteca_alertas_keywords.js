/**
 * Palavras-chave salvas do usuário para filtrar alertas da biblioteca.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('users', 'biblioteca_alertas_keywords');
  if (!has) {
    await knex.schema.alterTable('users', (table) => {
      table.string('biblioteca_alertas_keywords', 500).nullable();
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('users', 'biblioteca_alertas_keywords');
  if (has) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('biblioteca_alertas_keywords');
    });
  }
};
