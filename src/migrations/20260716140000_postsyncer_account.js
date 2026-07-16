/**
 * @param { import('knex').Knex } knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.integer('postsyncer_account_id').unsigned().nullable().after('postpulse_chat_id');
  });
};

/**
 * @param { import('knex').Knex } knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.dropColumn('postsyncer_account_id');
  });
};
