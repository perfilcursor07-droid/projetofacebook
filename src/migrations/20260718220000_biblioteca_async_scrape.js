/**
 * Persiste coletas assíncronas da Bright Data por fonte.
 * O snapshot sobrevive a reloads do PM2 e é processado pelo tick global.
 */
const PENDING_INDEX = 'biblioteca_fontes_scrape_pending_idx';

async function hasPendingIndex(knex) {
  const result = await knex.raw(
    'SHOW INDEX FROM biblioteca_fontes WHERE Key_name = ?',
    [PENDING_INDEX]
  );
  return Array.isArray(result?.[0]) && result[0].length > 0;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('biblioteca_fontes'))) return;

  const [hasSnapshotId, hasStatus, hasRequestedAt, hasError, hasSilentFirst] = await Promise.all([
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_snapshot_id'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_status'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_requested_at'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_error'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_silent_first'),
  ]);

  await knex.schema.alterTable('biblioteca_fontes', (table) => {
    if (!hasSnapshotId) table.string('scrape_snapshot_id', 100).nullable();
    if (!hasStatus) table.string('scrape_status', 30).nullable();
    if (!hasRequestedAt) table.timestamp('scrape_requested_at').nullable();
    if (!hasError) table.text('scrape_error').nullable();
    if (!hasSilentFirst) table.boolean('scrape_silent_first').notNullable().defaultTo(false);
  });

  if (!(await hasPendingIndex(knex))) {
    await knex.schema.alterTable('biblioteca_fontes', (table) => {
      table.index(['scrape_status', 'scrape_requested_at'], PENDING_INDEX);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('biblioteca_fontes'))) return;

  const [hasSnapshotId, hasStatus, hasRequestedAt, hasError, hasSilentFirst] = await Promise.all([
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_snapshot_id'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_status'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_requested_at'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_error'),
    knex.schema.hasColumn('biblioteca_fontes', 'scrape_silent_first'),
  ]);

  if (await hasPendingIndex(knex)) {
    await knex.schema.alterTable('biblioteca_fontes', (table) => {
      table.dropIndex(['scrape_status', 'scrape_requested_at'], PENDING_INDEX);
    });
  }

  await knex.schema.alterTable('biblioteca_fontes', (table) => {
    if (hasSnapshotId) table.dropColumn('scrape_snapshot_id');
    if (hasStatus) table.dropColumn('scrape_status');
    if (hasRequestedAt) table.dropColumn('scrape_requested_at');
    if (hasError) table.dropColumn('scrape_error');
    if (hasSilentFirst) table.dropColumn('scrape_silent_first');
  });
};
