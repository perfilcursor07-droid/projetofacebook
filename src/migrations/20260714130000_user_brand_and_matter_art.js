/**
 * Identidade visual por usuário e rastreamento da imagem editorial usada na arte.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('logo_path', 500).nullable();
    table.string('marca_nome', 120).nullable();
    table.string('marca_categoria', 80).nullable().defaultTo('ÚLTIMAS');
    table.string('marca_rodape', 160).nullable();
    table.string('marca_cor_primaria', 7).notNullable().defaultTo('#ffbd59');
    table.string('marca_cor_secundaria', 7).notNullable().defaultTo('#fb923c');
  });

  await knex.schema.alterTable('ai_matters', (table) => {
    table.string('imagem_fonte_url', 1000).nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('ai_matters', (table) => {
    table.dropColumn('imagem_fonte_url');
  });

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('logo_path');
    table.dropColumn('marca_nome');
    table.dropColumn('marca_categoria');
    table.dropColumn('marca_rodape');
    table.dropColumn('marca_cor_primaria');
    table.dropColumn('marca_cor_secundaria');
  });
};
