/**
 * Grupos do Facebook para repostagem via Ayrshare.
 * Cada grupo é conectado no painel Ayrshare e tem sua Profile-Key própria
 * (mesmo modelo já usado por facebook_pages.ayrshare_profile_key).
 */
exports.up = async function up(knex) {
  const existe = await knex.schema.hasTable('facebook_groups');
  if (existe) return;

  await knex.schema.createTable('facebook_groups', (table) => {
    table.increments('id').primary();
    table
      .integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('nome', 200).notNullable();
    table.string('nicho', 120).nullable();
    table.string('url', 500).nullable();
    table.string('grupo_fb_id', 100).nullable();
    // Profile-Key do Ayrshare que tem ESTE grupo conectado
    table.string('ayrshare_profile_key', 200).nullable();
    table.boolean('ativo').notNullable().defaultTo(true);
    // Entra por padrão na seleção ao publicar
    table.boolean('padrao').notNullable().defaultTo(false);
    table.text('observacoes').nullable();
    table.timestamp('ultimo_post_em').nullable();
    table.text('ultimo_erro').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'ativo']);
    table.index(['user_id', 'nicho']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('facebook_groups');
};
