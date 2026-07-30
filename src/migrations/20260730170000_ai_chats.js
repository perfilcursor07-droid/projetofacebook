/**
 * Chat de matérias (estilo DeepSeek): conversas salvas + mensagens,
 * para o usuário iterar com a IA antes de virar rascunho em ai_matters.
 */
exports.up = async function up(knex) {
  const temChats = await knex.schema.hasTable('ai_chats');
  if (!temChats) {
    await knex.schema.createTable('ai_chats', (table) => {
      table.increments('id');
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table
        .integer('facebook_page_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('facebook_pages')
        .onDelete('SET NULL');
      table.string('titulo', 180).nullable();
      table.boolean('pesquisar_web').notNullable().defaultTo(true);
      table.string('tom', 30).notNullable().defaultTo('natural');
      table.string('periodo', 10).notNullable().defaultTo('30d');
      table.datetime('last_message_at').nullable();
      table.timestamps(true, true);
      table.index(['user_id', 'last_message_at'], 'ai_chats_user_last_msg_idx');
    });
  }

  const temMsgs = await knex.schema.hasTable('ai_chat_messages');
  if (!temMsgs) {
    await knex.schema.createTable('ai_chat_messages', (table) => {
      table.increments('id');
      table
        .integer('chat_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('ai_chats')
        .onDelete('CASCADE');
      table.string('role', 16).notNullable().defaultTo('user');
      table.text('content', 'mediumtext').nullable();
      table.string('titulo', 200).nullable();
      table.text('hashtags').nullable();
      table.text('passos', 'mediumtext').nullable();
      table.text('fontes', 'mediumtext').nullable();
      table.boolean('pesquisou_web').notNullable().defaultTo(false);
      table
        .integer('matter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ai_matters')
        .onDelete('SET NULL');
      table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      table.index(['chat_id', 'id'], 'ai_chat_messages_chat_idx');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_chat_messages');
  await knex.schema.dropTableIfExists('ai_chats');
};
