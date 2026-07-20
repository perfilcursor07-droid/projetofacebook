/**
 * Cache de visualizações/impressões do post no Facebook.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasViews = await knex.schema.hasColumn('publications', 'fb_views');
  if (!hasViews) {
    await knex.schema.alterTable('publications', (table) => {
      table.integer('fb_views').unsigned().nullable().after('fb_post_url');
      table.timestamp('fb_views_at').nullable().after('fb_views');
      table.string('fb_native_post_id', 128).nullable().after('fb_views_at');
    });
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasViews = await knex.schema.hasColumn('publications', 'fb_views');
  if (hasViews) {
    await knex.schema.alterTable('publications', (table) => {
      table.dropColumn('fb_views');
      table.dropColumn('fb_views_at');
      table.dropColumn('fb_native_post_id');
    });
  }
};
