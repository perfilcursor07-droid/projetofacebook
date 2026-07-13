require('dotenv').config();

function parseDatabaseUrl(url) {
  if (!url) {
    return {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'clipador',
    };
  }

  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

const connection = parseDatabaseUrl(process.env.DATABASE_URL);

module.exports = {
  development: {
    client: 'mysql2',
    connection,
    migrations: {
      directory: './src/migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './src/seeds',
    },
  },
  production: {
    client: 'mysql2',
    connection,
    pool: { min: 2, max: 10 },
    migrations: {
      directory: './src/migrations',
      tableName: 'knex_migrations',
    },
  },
};
