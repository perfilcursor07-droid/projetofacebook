/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('biblioteca_posts'))) return;
  if (await knex.schema.hasColumn('biblioteca_posts', 'media_url')) return;

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.text('media_url').nullable().after('thumbnail');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('biblioteca_posts'))) return;
  if (!(await knex.schema.hasColumn('biblioteca_posts', 'media_url'))) return;

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.dropColumn('media_url');
  });
};
