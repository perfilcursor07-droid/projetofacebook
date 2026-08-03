/**
 * Uma resposta do chat pode conter várias matérias (ex.: "escreva 5 matérias
 * sobre X"). matter_id guarda só um rascunho; matter_ids guarda o mapa
 * { indiceDaMateria: matterId } de todos os rascunhos salvos da mensagem.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('ai_chat_messages');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('ai_chat_messages', 'matter_ids');
  if (hasCol) return;
  await knex.schema.alterTable('ai_chat_messages', (table) => {
    table.text('matter_ids').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('ai_chat_messages');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('ai_chat_messages', 'matter_ids');
  if (!hasCol) return;
  await knex.schema.alterTable('ai_chat_messages', (table) => {
    table.dropColumn('matter_ids');
  });
};
