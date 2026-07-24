/**
 * Profile Key Ayrshare por página (1 User Profile = 1 Página Facebook).
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('facebook_pages', 'ayrshare_profile_key');
  if (has) return;
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.string('ayrshare_profile_key', 128).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('facebook_pages', 'ayrshare_profile_key');
  if (!has) return;
  await knex.schema.alterTable('facebook_pages', (table) => {
    table.dropColumn('ayrshare_profile_key');
  });
};
