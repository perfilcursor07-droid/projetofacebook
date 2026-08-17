/**
 * Três títulos alternativos ao principal, oferecidos toda vez que uma matéria
 * é gerada (chat de matérias e biblioteca/agendar). Guardados como JSON.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ai_matters')) {
    const existe = await knex.schema.hasColumn('ai_matters', 'titulos_alternativos');
    if (!existe) {
      await knex.schema.alterTable('ai_matters', (table) => {
        table.text('titulos_alternativos').nullable();
      });
    }
  }

  if (await knex.schema.hasTable('ai_chat_messages')) {
    const existe = await knex.schema.hasColumn('ai_chat_messages', 'titulos_alternativos');
    if (!existe) {
      await knex.schema.alterTable('ai_chat_messages', (table) => {
        table.text('titulos_alternativos').nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('ai_chat_messages')) {
    const existe = await knex.schema.hasColumn('ai_chat_messages', 'titulos_alternativos');
    if (existe) {
      await knex.schema.alterTable('ai_chat_messages', (table) => {
        table.dropColumn('titulos_alternativos');
      });
    }
  }

  if (await knex.schema.hasTable('ai_matters')) {
    const existe = await knex.schema.hasColumn('ai_matters', 'titulos_alternativos');
    if (existe) {
      await knex.schema.alterTable('ai_matters', (table) => {
        table.dropColumn('titulos_alternativos');
      });
    }
  }
};
