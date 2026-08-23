/** Separa o fluxo editorial do chat livre com o Claude. */
exports.up = async function up(knex) {
  const existe = await knex.schema.hasColumn('ai_chats', 'modo');
  if (!existe) {
    await knex.schema.alterTable('ai_chats', (table) => {
      table.string('modo', 20).notNullable().defaultTo('materia').after('titulo');
      table.index(['user_id', 'modo'], 'ai_chats_user_modo_idx');
    });
  }
};

exports.down = async function down(knex) {
  const existe = await knex.schema.hasColumn('ai_chats', 'modo');
  if (existe) {
    await knex.schema.alterTable('ai_chats', (table) => {
      table.dropIndex(['user_id', 'modo'], 'ai_chats_user_modo_idx');
      table.dropColumn('modo');
    });
  }
};

