/**
 * Snapshot do texto gerado pela IA + memória editorial por usuário
 * (aprendizado a partir de edições humanas).
 */
exports.up = async function up(knex) {
  const hasMatters = await knex.schema.hasTable('ai_matters');
  if (hasMatters) {
    const hasTituloIa = await knex.schema.hasColumn('ai_matters', 'titulo_ia');
    const hasMateriaIa = await knex.schema.hasColumn('ai_matters', 'materia_ia');
    await knex.schema.alterTable('ai_matters', (table) => {
      if (!hasTituloIa) table.string('titulo_ia', 300).nullable();
      if (!hasMateriaIa) table.text('materia_ia').nullable();
    });
  }

  if (!(await knex.schema.hasTable('editorial_aprendizados'))) {
    await knex.schema.createTable('editorial_aprendizados', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table
        .integer('matter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ai_matters')
        .onDelete('SET NULL');
      table.string('titulo_antes', 300).nullable();
      table.string('titulo_depois', 300).nullable();
      table.text('materia_antes').nullable();
      table.text('materia_depois').nullable();
      table.string('diff_resumo', 500).nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['user_id', 'created_at']);
    });
  }

  if (!(await knex.schema.hasTable('editorial_estilo_usuario'))) {
    await knex.schema.createTable('editorial_estilo_usuario', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table.text('regras_estilo').nullable();
      table.integer('total_edicoes').unsigned().notNullable().defaultTo(0);
      table.timestamp('atualizado_em').nullable();
      table.timestamps(true, true);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('editorial_estilo_usuario');
  await knex.schema.dropTableIfExists('editorial_aprendizados');

  const hasMatters = await knex.schema.hasTable('ai_matters');
  if (!hasMatters) return;
  const hasTituloIa = await knex.schema.hasColumn('ai_matters', 'titulo_ia');
  const hasMateriaIa = await knex.schema.hasColumn('ai_matters', 'materia_ia');
  if (hasTituloIa || hasMateriaIa) {
    await knex.schema.alterTable('ai_matters', (table) => {
      if (hasMateriaIa) table.dropColumn('materia_ia');
      if (hasTituloIa) table.dropColumn('titulo_ia');
    });
  }
};
