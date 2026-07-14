const bcrypt = require('bcryptjs');

/**
 * Usuário padrão: admin / admin
 * @param {import('knex').Knex} knex
 */
exports.seed = async function seed(knex) {
  const email = 'admin';
  const hash = await bcrypt.hash('admin', 10);
  const existing = await knex('users').where({ email }).first();

  if (existing) {
    await knex('users').where({ id: existing.id }).update({
      nome: 'Admin',
      senha_hash: hash,
    });
    return;
  }

  await knex('users').insert({
    nome: 'Admin',
    email,
    senha_hash: hash,
  });
};
