/** Permite manter conversas importantes no topo da barra lateral. */
exports.up = async function up(knex) {
  const existe = await knex.schema.hasColumn('ai_chats', 'fixado');
  if (!existe) {
    await knex.schema.alterTable('ai_chats', (table) => {
      table.boolean('fixado').notNullable().defaultTo(false).after('modo');
      table.index(
        ['user_id', 'fixado', 'last_message_at'],
        'ai_chats_user_fixado_last_idx'
      );
    });
  }
};

exports.down = async function down(knex) {
  const existe = await knex.schema.hasColumn('ai_chats', 'fixado');
  if (existe) {
    await knex.schema.alterTable('ai_chats', (table) => {
      table.dropIndex(
        ['user_id', 'fixado', 'last_message_at'],
        'ai_chats_user_fixado_last_idx'
      );
      table.dropColumn('fixado');
    });
  }
};
