/**
 * Preserva o tipo de mídia detectado pela fonte para o piloto decidir
 * entre matéria com foto e o pipeline completo de Reel.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('biblioteca_posts', 'media_type');
  if (!hasColumn) {
    await knex.schema.alterTable('biblioteca_posts', (table) => {
      table.string('media_type', 20).notNullable().defaultTo('post').index();
    });
  }

  await knex('biblioteca_posts')
    .where(function videoUrls() {
      this.where('url', 'like', '%/reel/%')
        .orWhere('url', 'like', '%/reels/%')
        .orWhere('url', 'like', '%/tv/%');
    })
    .update({ media_type: 'video' });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('biblioteca_posts', 'media_type');
  if (hasColumn) {
    await knex.schema.alterTable('biblioteca_posts', (table) => {
      table.dropColumn('media_type');
    });
  }
};
