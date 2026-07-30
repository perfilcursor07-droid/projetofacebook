/**
 * Guarda qual palavra-chave da Biblioteca bateu no item ao montar a agenda.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('biblioteca_agenda', 'matched_keyword');
  if (has) return;
  await knex.schema.alterTable('biblioteca_agenda', (table) => {
    table.string('matched_keyword', 60).nullable().after('status');
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('biblioteca_agenda', 'matched_keyword');
  if (!has) return;
  await knex.schema.alterTable('biblioteca_agenda', (table) => {
    table.dropColumn('matched_keyword');
  });
};
