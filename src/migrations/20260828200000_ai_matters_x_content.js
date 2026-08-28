/** Conteúdo exclusivo do X, sem alterar Facebook ou Instagram. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ai_matters'))) return;
  const temTexto = await knex.schema.hasColumn('ai_matters', 'texto_x');
  const temImagem = await knex.schema.hasColumn('ai_matters', 'imagem_x_url');
  if (temTexto && temImagem) return;
  await knex.schema.alterTable('ai_matters', (table) => {
    if (!temTexto) table.text('texto_x').nullable();
    if (!temImagem) table.text('imagem_x_url').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ai_matters'))) return;
  const temTexto = await knex.schema.hasColumn('ai_matters', 'texto_x');
  const temImagem = await knex.schema.hasColumn('ai_matters', 'imagem_x_url');
  if (!temTexto && !temImagem) return;
  await knex.schema.alterTable('ai_matters', (table) => {
    if (temImagem) table.dropColumn('imagem_x_url');
    if (temTexto) table.dropColumn('texto_x');
  });
};
