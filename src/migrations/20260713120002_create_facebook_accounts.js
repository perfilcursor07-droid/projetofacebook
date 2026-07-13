/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('facebook_accounts', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('fb_user_id', 64).notNullable();
    table.text('access_token').notNullable();
    table.timestamp('expires_at').nullable();
    table.timestamps(true, true);

    table.unique(['user_id', 'fb_user_id']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('facebook_accounts');
};
