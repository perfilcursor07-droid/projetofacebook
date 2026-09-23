exports.up = async (knex) => {
  await knex.schema.createTable('page_distribution_settings', (t) => {
    t.integer('user_id').unsigned().primary().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('enabled').notNullable().defaultTo(false);
  });
  await knex.schema.createTable('page_distribution_targets', (t) => {
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('page_id').unsigned().notNullable().references('id').inTable('facebook_pages').onDelete('CASCADE');
    t.boolean('selected').notNullable().defaultTo(false);
    t.text('brand', 'longtext').nullable();
    t.primary(['user_id', 'page_id']);
  });
  await knex.schema.alterTable('ai_matters', (t) => {
    t.text('distribution_brand', 'longtext').nullable();
  });
  await knex.schema.createTable('page_distribution_items', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('source_id').unsigned().notNullable().references('id').inTable('ai_matters').onDelete('CASCADE');
    t.integer('page_id').unsigned().notNullable().references('id').inTable('facebook_pages').onDelete('CASCADE');
    t.integer('matter_id').unsigned().nullable().references('id').inTable('ai_matters').onDelete('SET NULL');
    t.string('state', 24).notNullable().defaultTo('pending');
    t.string('error', 500).nullable();
    t.string('fingerprint', 64).nullable();
    t.timestamps(true, true);
    t.unique(['user_id', 'source_id', 'page_id']);
  });
};
exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('page_distribution_items');
  await knex.schema.alterTable('ai_matters', (t) => t.dropColumn('distribution_brand'));
  await knex.schema.dropTableIfExists('page_distribution_targets');
  await knex.schema.dropTableIfExists('page_distribution_settings');
};
