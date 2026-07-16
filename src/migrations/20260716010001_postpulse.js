/**
 * PostPulse: token OAuth por usuário + vínculo com páginas do Facebook.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('postpulse_connections', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE')
      .unique();
    table.text('access_token').notNullable();
    table.text('refresh_token').nullable();
    table.timestamp('expires_at').nullable();
    table.timestamps(true, true);
  });

  await knex.schema.alterTable('facebook_pages', (table) => {
    table.integer('postpulse_account_id').unsigned().nullable().after('page_access_token');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.dropColumn('postpulse_account_id');
  });
  await knex.schema.dropTableIfExists('postpulse_connections');
};
