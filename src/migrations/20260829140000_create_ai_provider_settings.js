/**
 * Configuração global dos provedores usados pelo /materia-manual.
 * As chaves são cifradas pela aplicação antes de chegar ao banco.
 *
 * Mantida mesmo após o revert da tela de Provedores IA: em produção
 * esta migration já rodou e o Knex exige o arquivo no diretório.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('ai_provider_settings');
  if (exists) return;
  await knex.schema.createTable('ai_provider_settings', (table) => {
    table.increments('id').primary();
    table.string('provider', 32).notNullable().unique();
    table.text('api_key_cipher').nullable();
    table.string('model', 120).notNullable();
    table.boolean('selected_materia_manual').notNullable().defaultTo(false).index();
    table.string('last_test_status', 20).nullable();
    table.string('last_test_message', 500).nullable();
    table.timestamp('last_test_at').nullable();
    table.timestamps(true, true);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_provider_settings');
};
