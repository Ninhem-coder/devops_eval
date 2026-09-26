// L'application Express. On l'exporte SANS la démarrer :
// comme ça, les tests peuvent l'utiliser directement.
const express = require('express');
const { pool } = require('./db');

const app = express();
app.use(express.json());

// Santé : on vérifie VRAIMENT que la base répond.
// Si Postgres est down -> 503, et le HEALTHCHECK Docker le verra.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(500).json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Lister les notes
app.get('/notes', async (req, res) => {
  const { rows } = await pool.query('SELECT id, text, created_at FROM notes ORDER BY id');
  res.json(rows);
});

// Créer une note
app.post('/notes', async (req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'le champ "text" est obligatoire' });
  }
  const { rows } = await pool.query(
    'INSERT INTO notes (text) VALUES ($1) RETURNING id, text, created_at',
    [text.trim()]
  );
  res.status(201).json(rows[0]);
});

// Filet de sécurité : toute erreur non gérée -> 500 propre
// Express reconnaît un gestionnaire d'erreur à ses 4 paramètres, donc "next" doit rester
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
