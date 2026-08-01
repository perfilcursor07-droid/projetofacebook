/**
 * Modelo de arte secundário (opcional) — troca rápida no editor da matéria.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('users', 'marca_modelo_arte_secundario');
  if (!has) {
    await knex.schema.alterTable('users', (table) => {
      table.string('marca_modelo_arte_secundario', 40).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('users', 'marca_modelo_arte_secundario');
  if (has) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('marca_modelo_arte_secundario');
    });
  }
};
