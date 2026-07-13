const bcrypt = require('bcryptjs');

/**
 * @param {import('knex').Knex} knex
 */
exports.seed = async function seed(knex) {
  const email = 'admin@clipador.local';
  const existing = await knex('users').where({ email }).first();
  if (existing) return;

  await knex('users').insert({
    nome: 'Admin Clipador',
    email,
    senha_hash: await bcrypt.hash('clipador123', 10),
  });
};
