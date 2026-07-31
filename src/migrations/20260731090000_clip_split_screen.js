/**
 * Tela dividida no corte: metade imagem (Brave/upload/frame) + metade vídeo,
 * com deslocamento horizontal independente para cada lado.
 * @param {import('knex').Knex} knex
 */
const COLUMNS = [
  'layout',
  'split_status',
  'split_image_path',
  'split_image_origem',
  'split_image_url',
  'split_video_offset',
  'split_image_offset',
  'arquivo_sem_split',
  'split_erro',
];

exports.up = async function up(knex) {
  const existing = {};
  for (const column of COLUMNS) {
    existing[column] = await knex.schema.hasColumn('video_clips', column);
  }

  await knex.schema.alterTable('video_clips', (table) => {
    if (!existing.layout) {
      table.enum('layout', ['normal', 'split']).notNullable().defaultTo('normal');
    }
    if (!existing.split_status) {
      table
        .enum('split_status', ['pendente', 'gerando', 'pronta', 'erro'])
        .notNullable()
        .defaultTo('pendente');
    }
    if (!existing.split_image_path) table.string('split_image_path', 500).nullable();
    if (!existing.split_image_origem) table.string('split_image_origem', 30).nullable();
    if (!existing.split_image_url) table.string('split_image_url', 1000).nullable();
    // 0 = encostado à esquerda, 50 = centro, 100 = encostado à direita
    if (!existing.split_video_offset) table.decimal('split_video_offset', 5, 2).notNullable().defaultTo(50);
    if (!existing.split_image_offset) table.decimal('split_image_offset', 5, 2).notNullable().defaultTo(50);
    if (!existing.arquivo_sem_split) table.string('arquivo_sem_split', 500).nullable();
    if (!existing.split_erro) table.string('split_erro', 400).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const existing = {};
  for (const column of COLUMNS) {
    existing[column] = await knex.schema.hasColumn('video_clips', column);
  }

  await knex.schema.alterTable('video_clips', (table) => {
    for (const column of COLUMNS) {
      if (existing[column]) table.dropColumn(column);
    }
  });
};
