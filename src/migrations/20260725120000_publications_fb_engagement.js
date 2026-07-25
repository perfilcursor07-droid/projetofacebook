/**
 * Engajamento FB: curtidas / comentários / compartilhamentos nas publicações.
 */
exports.up = async function up(knex) {
  const hasLikes = await knex.schema.hasColumn('publications', 'fb_likes');
  const hasComments = await knex.schema.hasColumn('publications', 'fb_comments');
  const hasShares = await knex.schema.hasColumn('publications', 'fb_shares');

  await knex.schema.alterTable('publications', (table) => {
    if (!hasLikes) table.integer('fb_likes').unsigned().nullable().after('fb_views_at');
    if (!hasComments) table.integer('fb_comments').unsigned().nullable().after('fb_likes');
    if (!hasShares) table.integer('fb_shares').unsigned().nullable().after('fb_comments');
  });
};

exports.down = async function down(knex) {
  const hasLikes = await knex.schema.hasColumn('publications', 'fb_likes');
  const hasComments = await knex.schema.hasColumn('publications', 'fb_comments');
  const hasShares = await knex.schema.hasColumn('publications', 'fb_shares');

  await knex.schema.alterTable('publications', (table) => {
    if (hasShares) table.dropColumn('fb_shares');
    if (hasComments) table.dropColumn('fb_comments');
    if (hasLikes) table.dropColumn('fb_likes');
  });
};
