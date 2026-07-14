/**
 * Garante que a conta administrativa histórica mantenha acesso total.
 * Separado do seed original para preservar sua compatibilidade.
 * @param {import('knex').Knex} knex
 */
exports.seed = async function seed(knex) {
  const hasAccessColumn = await knex.schema.hasColumn('users', 'nivel_acesso');
  if (!hasAccessColumn) return;
  await knex('users').where({ email: 'admin' }).update({ nivel_acesso: 'administrador' });
};
