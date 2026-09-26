// Test d'intégration : on appelle la vraie API ET on vérifie dans la vraie base Postgres.
// supertest envoie des requêtes HTTP à l'app sans ouvrir de port.
const request = require('supertest');
const app = require('../src/app');
const { pool, init } = require('../src/db');

beforeAll(async () => {
  await init(); // crée la table si besoin
  await pool.query('TRUNCATE notes RESTART IDENTITY'); // on part d'une table vide
});

afterAll(async () => {
  await pool.end(); // ferme les connexions, sinon Jest ne s'arrête pas
});

test('POST /notes crée une note, la renvoie en 201 et l\'enregistre dans Postgres', async () => {
  const res = await request(app).post('/notes').send({ text: 'acheter du pain' });

  // 1. Code de retour HTTP
  expect(res.status).toBe(201);

  // 2. Contenu de la réponse
  expect(res.body.text).toBe('acheter du pain');
  expect(res.body.id).toEqual(expect.any(Number));

  // 3. Interaction avec un service : la note est VRAIMENT dans la base
  const { rows } = await pool.query('SELECT text FROM notes WHERE id = $1', [res.body.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe('acheter du pain');
});
