/**
 * Acelera contagem de posts por fonte na página /biblioteca.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('biblioteca_posts');
  if (!has) return;

  const indexes = await knex.raw(
    "SHOW INDEX FROM biblioteca_posts WHERE Key_name = 'biblioteca_posts_user_fonte_idx'"
  );
  const rows = Array.isArray(indexes?.[0]) ? indexes[0] : indexes;
  if (rows && rows.length) return;

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.index(['user_id', 'fonte_id'], 'biblioteca_posts_user_fonte_idx');
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('biblioteca_posts');
  if (!has) return;
  try {
    await knex.schema.alterTable('biblioteca_posts', (table) => {
      table.dropIndex(['user_id', 'fonte_id'], 'biblioteca_posts_user_fonte_idx');
    });
  } catch {
    /* ignore */
  }
};
