/**
 * Crédito/fonte exibido na legenda do Facebook (ex.: "Fonte: G1" / "(Foto: Reprodução)").
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('ai_matters', 'fonte_credito');
  if (!has) {
    await knex.schema.alterTable('ai_matters', (table) => {
      table.string('fonte_credito', 400).nullable().after('fonte_resumo');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('ai_matters', 'fonte_credito');
  if (has) {
    await knex.schema.alterTable('ai_matters', (table) => {
      table.dropColumn('fonte_credito');
    });
  }
};
