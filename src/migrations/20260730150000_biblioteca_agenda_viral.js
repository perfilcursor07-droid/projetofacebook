/**
 * Agenda de viralizadas: post_id passa a ser opcional;
 * source_matter_id aponta para a matéria original que viralizou.
 */
exports.up = async function up(knex) {
  const hasSource = await knex.schema.hasColumn('biblioteca_agenda', 'source_matter_id');
  if (!hasSource) {
    await knex.schema.alterTable('biblioteca_agenda', (table) => {
      table
        .integer('source_matter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ai_matters')
        .onDelete('SET NULL')
        .after('matter_id');
      table.index(['user_id', 'source_matter_id'], 'biblioteca_agenda_user_source_matter_idx');
    });
  }

  // MySQL: altera post_id para nullable sem dropar o FK
  await knex.raw(
    'ALTER TABLE biblioteca_agenda MODIFY COLUMN post_id INT UNSIGNED NULL'
  );
};

exports.down = async function down(knex) {
  const hasSource = await knex.schema.hasColumn('biblioteca_agenda', 'source_matter_id');
  if (hasSource) {
    await knex.schema.alterTable('biblioteca_agenda', (table) => {
      table.dropIndex(['user_id', 'source_matter_id'], 'biblioteca_agenda_user_source_matter_idx');
      table.dropForeign(['source_matter_id']);
      table.dropColumn('source_matter_id');
    });
  }
  // Não força NOT NULL de volta — pode haver linhas com post_id null
};
