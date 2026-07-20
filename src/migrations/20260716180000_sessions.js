/**
 * Sessões Express no MySQL (sobrevive a pm2 reload / restart).
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('sessions');
  if (exists) return;

  await knex.schema.createTable('sessions', (t) => {
    // 191 evita "Specified key was too long" em MySQL antigo / utf8mb4 (máx. ~1000 bytes)
    t.string('session_id', 191).primary();
    t.text('data').notNullable();
    t.timestamp('expires').notNullable().index();
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sessions');
};
