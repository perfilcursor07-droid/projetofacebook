/**
 * Resultado persistido da análise editorial para exibir recomendações manuais.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;

  const hasScore = await knex.schema.hasColumn('biblioteca_posts', 'viral_score');
  const hasReason = await knex.schema.hasColumn('biblioteca_posts', 'viral_reason');
  const hasAnalyzedAt = await knex.schema.hasColumn('biblioteca_posts', 'viral_analyzed_at');

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    if (!hasScore) table.integer('viral_score').unsigned().nullable().index();
    if (!hasReason) table.string('viral_reason', 500).nullable();
    if (!hasAnalyzedAt) table.timestamp('viral_analyzed_at').nullable().index();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('biblioteca_posts');
  if (!hasTable) return;

  const hasScore = await knex.schema.hasColumn('biblioteca_posts', 'viral_score');
  const hasReason = await knex.schema.hasColumn('biblioteca_posts', 'viral_reason');
  const hasAnalyzedAt = await knex.schema.hasColumn('biblioteca_posts', 'viral_analyzed_at');

  await knex.schema.alterTable('biblioteca_posts', (table) => {
    if (hasAnalyzedAt) table.dropColumn('viral_analyzed_at');
    if (hasReason) table.dropColumn('viral_reason');
    if (hasScore) table.dropColumn('viral_score');
  });
};
