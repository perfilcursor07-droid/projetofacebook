/**
 * chatId da Página no PostPulse (Facebook Pages = chats).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.string('postpulse_chat_id', 128).nullable().after('postpulse_account_id');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.dropColumn('postpulse_chat_id');
  });
};
