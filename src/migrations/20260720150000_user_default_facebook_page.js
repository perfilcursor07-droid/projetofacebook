/**
 * Página do Facebook padrão do usuário (pré-selecionada ao publicar).
 */
exports.up = async function up(knex) {
  const hasUsers = await knex.schema.hasTable('users');
  if (!hasUsers) return;
  const hasCol = await knex.schema.hasColumn('users', 'default_facebook_page_id');
  if (hasCol) return;

  await knex.schema.alterTable('users', (table) => {
    table
      .integer('default_facebook_page_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('SET NULL');
  });
};

exports.down = async function down(knex) {
  const hasUsers = await knex.schema.hasTable('users');
  if (!hasUsers) return;
  const hasCol = await knex.schema.hasColumn('users', 'default_facebook_page_id');
  if (!hasCol) return;
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('default_facebook_page_id');
  });
};
