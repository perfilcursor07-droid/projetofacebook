/**
 * Personalização por modelo de arte.
 *
 * As opções da marca (cores, fonte, tamanho do título) são gerais. Este campo
 * guarda ajustes por modelo — ex.: o JM com título menor e faixa sólida,
 * enquanto o Urgente alerta segue com o padrão da marca.
 * Formato: { "<modelo>": { tituloTamanho, tituloCor, corPrimaria, ... } }
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('users'))) return;
  if (await knex.schema.hasColumn('users', 'marca_modelo_config')) return;
  await knex.schema.alterTable('users', (table) => {
    table.text('marca_modelo_config', 'mediumtext').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('users'))) return;
  if (!(await knex.schema.hasColumn('users', 'marca_modelo_config'))) return;
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('marca_modelo_config');
  });
};
