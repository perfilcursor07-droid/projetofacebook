/**
 * Piloto da Biblioteca: modo aguardar aprovação + filtro só sites.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('biblioteca_autopilot');
  if (!has) return;

  const hasModo = await knex.schema.hasColumn('biblioteca_autopilot', 'modo');
  if (!hasModo) {
    await knex.schema.alterTable('biblioteca_autopilot', (table) => {
      // publicar | aguardar_aprovacao
      table.string('modo', 32).notNullable().defaultTo('publicar');
      table.boolean('somente_sites').notNullable().defaultTo(false);
      table.integer('total_gerados').unsigned().notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('biblioteca_autopilot');
  if (!has) return;
  const hasModo = await knex.schema.hasColumn('biblioteca_autopilot', 'modo');
  if (!hasModo) return;

  await knex.schema.alterTable('biblioteca_autopilot', (table) => {
    table.dropColumn('modo');
    table.dropColumn('somente_sites');
    table.dropColumn('total_gerados');
  });
};
