// Connexion à PostgreSQL.
// Toute la config vient des variables d'environnement (jamais de mot de passe en dur).
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || 'app',
  database: process.env.DB_NAME || 'app',
  connectionTimeoutMillis: 2000, // /health ne doit pas rester bloqué si la base est injoignable
});

// Si la base coupe une connexion inactive, on log au lieu de crasher l'app.
// Sans ça, Node plante et /health ne peut même plus répondre 503.
pool.on('error', (err) => console.error('Erreur Postgres :', err.message));

// Crée la table si elle n'existe pas encore (appelé au démarrage).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = { pool, init };
