/**
 * Publicação no X.com via Ayrshare.
 * Cada Página escolhe se oferece X no editor; a matéria guarda a preferência
 * individual e a publicação registra o ID/URL retornados pelo X.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('facebook_pages')) {
    const temAtivo = await knex.schema.hasColumn('facebook_pages', 'x_ativo');
    const temUsuario = await knex.schema.hasColumn('facebook_pages', 'x_username');
    if (!temAtivo || !temUsuario) {
      await knex.schema.alterTable('facebook_pages', (table) => {
        if (!temAtivo) table.boolean('x_ativo').notNullable().defaultTo(false);
        if (!temUsuario) table.string('x_username', 190).nullable();
      });
    }
  }

  if (await knex.schema.hasTable('ai_matters')) {
    const tem = await knex.schema.hasColumn('ai_matters', 'publicar_x');
    if (!tem) {
      await knex.schema.alterTable('ai_matters', (table) => {
        table.boolean('publicar_x').notNullable().defaultTo(false);
      });
    }
  }

  if (await knex.schema.hasTable('publications')) {
    const temId = await knex.schema.hasColumn('publications', 'x_post_id');
    const temUrl = await knex.schema.hasColumn('publications', 'x_post_url');
    if (!temId || !temUrl) {
      await knex.schema.alterTable('publications', (table) => {
        if (!temId) table.string('x_post_id', 255).nullable();
        if (!temUrl) table.text('x_post_url').nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('publications')) {
    const temId = await knex.schema.hasColumn('publications', 'x_post_id');
    const temUrl = await knex.schema.hasColumn('publications', 'x_post_url');
    if (temId || temUrl) {
      await knex.schema.alterTable('publications', (table) => {
        if (temUrl) table.dropColumn('x_post_url');
        if (temId) table.dropColumn('x_post_id');
      });
    }
  }

  if (await knex.schema.hasTable('ai_matters')) {
    if (await knex.schema.hasColumn('ai_matters', 'publicar_x')) {
      await knex.schema.alterTable('ai_matters', (table) => table.dropColumn('publicar_x'));
    }
  }

  if (await knex.schema.hasTable('facebook_pages')) {
    const temAtivo = await knex.schema.hasColumn('facebook_pages', 'x_ativo');
    const temUsuario = await knex.schema.hasColumn('facebook_pages', 'x_username');
    if (temAtivo || temUsuario) {
      await knex.schema.alterTable('facebook_pages', (table) => {
        if (temUsuario) table.dropColumn('x_username');
        if (temAtivo) table.dropColumn('x_ativo');
      });
    }
  }
};
