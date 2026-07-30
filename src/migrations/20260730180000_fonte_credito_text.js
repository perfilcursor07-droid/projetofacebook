/**
 * Amplia fonte_credito para caber lista de links das fontes pesquisadas.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('ai_matters', 'fonte_credito');
  if (!has) return;
  await knex.schema.alterTable('ai_matters', (table) => {
    table.text('fonte_credito').alter();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('ai_matters', 'fonte_credito');
  if (!has) return;
  await knex.schema.alterTable('ai_matters', (table) => {
    table.string('fonte_credito', 400).alter();
  });
};
