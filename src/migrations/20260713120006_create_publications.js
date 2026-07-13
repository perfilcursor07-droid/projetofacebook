/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('publications', (table) => {
    table.increments('id').primary();
    table
      .integer('video_clip_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('video_clips')
      .onDelete('CASCADE');
    table
      .integer('facebook_page_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('facebook_pages')
      .onDelete('CASCADE');
    table.string('fb_post_id', 128).nullable();
    table.string('fb_post_url', 500).nullable();
    table.timestamp('published_at').nullable();
    table
      .enum('status', ['pendente', 'publicado', 'erro'])
      .notNullable()
      .defaultTo('pendente');
    table.text('erro_mensagem').nullable();
    table.integer('tentativas').unsigned().notNullable().defaultTo(0);
    table.timestamps(true, true);

    table.index(['facebook_page_id', 'status']);
    table.index(['video_clip_id']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('publications');
};
