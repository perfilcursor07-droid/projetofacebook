/**
 * Memória editorial persistente extraída das correções feitas no chat.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('editorial_estilo_usuario');
  if (!hasTable) return;

  const hasPreferences = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'preferencias_chat'
  );
  const hasFeedbackTotal = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'total_feedback_chat'
  );
  const hasLastMemoryAt = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'ultima_memoria_chat_em'
  );

  await knex.schema.alterTable('editorial_estilo_usuario', (table) => {
    if (!hasPreferences) table.text('preferencias_chat', 'mediumtext').nullable();
    if (!hasFeedbackTotal) {
      table.integer('total_feedback_chat').unsigned().notNullable().defaultTo(0);
    }
    if (!hasLastMemoryAt) table.timestamp('ultima_memoria_chat_em').nullable();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('editorial_estilo_usuario');
  if (!hasTable) return;

  const hasPreferences = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'preferencias_chat'
  );
  const hasFeedbackTotal = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'total_feedback_chat'
  );
  const hasLastMemoryAt = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'ultima_memoria_chat_em'
  );

  await knex.schema.alterTable('editorial_estilo_usuario', (table) => {
    if (hasLastMemoryAt) table.dropColumn('ultima_memoria_chat_em');
    if (hasFeedbackTotal) table.dropColumn('total_feedback_chat');
    if (hasPreferences) table.dropColumn('preferencias_chat');
  });
};
