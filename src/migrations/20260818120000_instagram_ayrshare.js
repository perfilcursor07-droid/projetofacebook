/**
 * Publicação no Instagram via Ayrshare.
 *
 * `instagram_ativo` liga a Página no ViralizeAI ao Instagram conectado no mesmo
 * User Profile da Ayrshare; `publicar_instagram` guarda a escolha do editor por
 * matéria. As colunas em publications registram o post do Instagram, que tem ID
 * próprio (separado do post do Facebook).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('facebook_pages')) {
    const temAtivo = await knex.schema.hasColumn('facebook_pages', 'instagram_ativo');
    const temUsuario = await knex.schema.hasColumn('facebook_pages', 'instagram_username');
    if (!temAtivo || !temUsuario) {
      await knex.schema.alterTable('facebook_pages', (table) => {
        if (!temAtivo) table.boolean('instagram_ativo').notNullable().defaultTo(false);
        if (!temUsuario) table.string('instagram_username', 190).nullable();
      });
    }
  }

  if (await knex.schema.hasTable('ai_matters')) {
    const tem = await knex.schema.hasColumn('ai_matters', 'publicar_instagram');
    if (!tem) {
      await knex.schema.alterTable('ai_matters', (table) => {
        table.boolean('publicar_instagram').notNullable().defaultTo(false);
      });
    }
  }

  if (await knex.schema.hasTable('publications')) {
    const temId = await knex.schema.hasColumn('publications', 'ig_post_id');
    const temUrl = await knex.schema.hasColumn('publications', 'ig_post_url');
    if (!temId || !temUrl) {
      await knex.schema.alterTable('publications', (table) => {
        if (!temId) table.string('ig_post_id', 190).nullable();
        if (!temUrl) table.string('ig_post_url', 500).nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('publications')) {
    const temId = await knex.schema.hasColumn('publications', 'ig_post_id');
    const temUrl = await knex.schema.hasColumn('publications', 'ig_post_url');
    if (temId || temUrl) {
      await knex.schema.alterTable('publications', (table) => {
        if (temUrl) table.dropColumn('ig_post_url');
        if (temId) table.dropColumn('ig_post_id');
      });
    }
  }

  if (await knex.schema.hasTable('ai_matters')) {
    if (await knex.schema.hasColumn('ai_matters', 'publicar_instagram')) {
      await knex.schema.alterTable('ai_matters', (table) => {
        table.dropColumn('publicar_instagram');
      });
    }
  }

  if (await knex.schema.hasTable('facebook_pages')) {
    const temAtivo = await knex.schema.hasColumn('facebook_pages', 'instagram_ativo');
    const temUsuario = await knex.schema.hasColumn('facebook_pages', 'instagram_username');
    if (temAtivo || temUsuario) {
      await knex.schema.alterTable('facebook_pages', (table) => {
        if (temUsuario) table.dropColumn('instagram_username');
        if (temAtivo) table.dropColumn('instagram_ativo');
      });
    }
  }
};
