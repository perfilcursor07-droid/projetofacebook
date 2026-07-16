/**
 * Sessões Express no MySQL (sobrevive a pm2 reload / restart).
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('sessions');
  if (exists) return;

  await knex.schema.createTable('sessions', (t) => {
    t.string('session_id', 255).primary();
    t.text('data').notNullable();
    t.timestamp('expires').notNullable().index();
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sessions');
};
