/**
 * Adiciona autorização por papel sem alterar a migration inicial já aplicada.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('nivel_acesso', 20).notNullable().defaultTo('usuario').index();
  });

  // Preserva o acesso total da conta administrativa criada pelo seed original.
  await knex('users').where({ email: 'admin' }).update({ nivel_acesso: 'administrador' });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('nivel_acesso');
  });
};
