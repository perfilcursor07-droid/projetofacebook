/**
 * Orientações escritas pelo editor na tela de agendar.
 *
 * Diferente de `preferencias_chat` (memória que a IA extrai sozinha das
 * correções), este campo é a instrução manual: o editor escreve uma vez e ela
 * passa a valer para todas as próximas matérias geradas.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('editorial_estilo_usuario');
  if (!hasTable) return;

  const hasOrientacoes = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'orientacoes_editor'
  );
  const hasAtualizadoEm = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'orientacoes_atualizadas_em'
  );
  if (hasOrientacoes && hasAtualizadoEm) return;

  await knex.schema.alterTable('editorial_estilo_usuario', (table) => {
    if (!hasOrientacoes) table.text('orientacoes_editor', 'mediumtext').nullable();
    if (!hasAtualizadoEm) table.timestamp('orientacoes_atualizadas_em').nullable();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('editorial_estilo_usuario');
  if (!hasTable) return;

  const hasOrientacoes = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'orientacoes_editor'
  );
  const hasAtualizadoEm = await knex.schema.hasColumn(
    'editorial_estilo_usuario',
    'orientacoes_atualizadas_em'
  );

  await knex.schema.alterTable('editorial_estilo_usuario', (table) => {
    if (hasAtualizadoEm) table.dropColumn('orientacoes_atualizadas_em');
    if (hasOrientacoes) table.dropColumn('orientacoes_editor');
  });
};
