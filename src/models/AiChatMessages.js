const db = require('../config/db');

const AiChatMessages = {
  table: 'ai_chat_messages',

  findById(id) {
    return db(this.table).where({ id }).first();
  },

  /** Mensagem + dono da conversa (para checar acesso sem 2 queries). */
  findByIdWithChat(id) {
    return db(`${this.table} as m`)
      .join('ai_chats as c', 'c.id', 'm.chat_id')
      .where('m.id', id)
      .first(
        'm.*',
        'c.user_id as chat_user_id',
        'c.facebook_page_id as chat_page_id',
        'c.titulo as chat_titulo'
      );
  },

  findByChat(chatId, { limit = 200 } = {}) {
    return db(this.table)
      .where({ chat_id: chatId })
      .orderBy('id', 'asc')
      .limit(Math.min(500, Math.max(1, Number(limit) || 200)));
  },

  async create(data) {
    const [id] = await db(this.table).insert(data);
    return id;
  },

  update(id, data) {
    return db(this.table).where({ id }).update(data);
  },

  remove(id) {
    return db(this.table).where({ id }).del();
  },
};

module.exports = AiChatMessages;
