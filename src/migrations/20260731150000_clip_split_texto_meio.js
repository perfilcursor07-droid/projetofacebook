/**
 * Posição "meio" para o texto fixo na tela dividida.
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  await knex.raw(`
    ALTER TABLE video_clips
    MODIFY COLUMN split_texto_posicao
    ENUM('topo', 'meio', 'rodape')
    NOT NULL DEFAULT 'rodape'
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const client = knex.client?.config?.client || '';
  if (!String(client).includes('mysql')) return;

  await knex('video_clips').where({ split_texto_posicao: 'meio' }).update({ split_texto_posicao: 'rodape' });
  await knex.raw(`
    ALTER TABLE video_clips
    MODIFY COLUMN split_texto_posicao
    ENUM('topo', 'rodape')
    NOT NULL DEFAULT 'rodape'
  `);
};
