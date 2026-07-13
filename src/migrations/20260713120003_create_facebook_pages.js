/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('facebook_pages', (table) => {
    table.increments('id').primary();
    table
      .integer('facebook_account_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('facebook_accounts')
      .onDelete('CASCADE');
    table.string('page_id', 64).notNullable();
    table.string('page_name', 255).notNullable();
    table.text('page_access_token').notNullable();
    table.timestamps(true, true);

    table.unique(['facebook_account_id', 'page_id']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('facebook_pages');
};
