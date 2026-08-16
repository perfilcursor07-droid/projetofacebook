/**
 * Trava de recusa no pré-agendamento.
 *
 * Quando o editor remove um item da agenda, o post voltava a ser candidato na
 * rodada seguinte de "montar agenda". Marcar a recusa no próprio post mantém a
 * decisão entre rodadas.
 */
exports.up = async function up(knex) {
  const existe = await knex.schema.hasColumn('biblioteca_posts', 'agenda_recusado_em');
  if (existe) return;
  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.timestamp('agenda_recusado_em').nullable();
    table.index(['user_id', 'agenda_recusado_em'], 'biblioteca_posts_agenda_recusado_idx');
  });
};

exports.down = async function down(knex) {
  const existe = await knex.schema.hasColumn('biblioteca_posts', 'agenda_recusado_em');
  if (!existe) return;
  await knex.schema.alterTable('biblioteca_posts', (table) => {
    table.dropIndex(['user_id', 'agenda_recusado_em'], 'biblioteca_posts_agenda_recusado_idx');
    table.dropColumn('agenda_recusado_em');
  });
};
