/**
 * Padrão da cor principal da marca: #FFBD59
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex('users')
    .whereIn('marca_cor_primaria', ['#facc15', '#FACC15'])
    .update({ marca_cor_primaria: '#ffbd59' });

  // MySQL: altera o DEFAULT da coluna
  await knex.raw(
    "ALTER TABLE `users` ALTER COLUMN `marca_cor_primaria` SET DEFAULT '#ffbd59'"
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex('users')
    .whereIn('marca_cor_primaria', ['#ffbd59', '#FFBD59'])
    .update({ marca_cor_primaria: '#facc15' });

  await knex.raw(
    "ALTER TABLE `users` ALTER COLUMN `marca_cor_primaria` SET DEFAULT '#facc15'"
  );
};
