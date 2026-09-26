// Tests d'intégration : on appelle la vraie API ET on vérifie dans la vraie base Postgres.
// supertest envoie des requêtes HTTP à l'app sans ouvrir de port.
const request = require('supertest');
const app = require('../src/app');
const { pool, init } = require('../src/db');

beforeAll(async () => {
  await init(); // crée la table si besoin
});

beforeEach(async () => {
  // Chaque test part d'une table vide -> tests indépendants et reproductibles
  await pool.query('TRUNCATE notes RESTART IDENTITY');
});

afterAll(async () => {
  await pool.end(); // ferme les connexions, sinon Jest ne s'arrête pas
});

describe('GET /health', () => {
  test('répond 200 et indique que la base est joignable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });
});

describe('POST /notes', () => {
  test('crée une note, la renvoie en 201 et l\'enregistre dans Postgres', async () => {
    const res = await request(app).post('/notes').send({ text: 'acheter du pain' });

    // 1. La réponse HTTP est correcte
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('acheter du pain');
    expect(res.body.id).toEqual(expect.any(Number));

    // 2. La note est VRAIMENT dans la base (on interroge Postgres directement)
    const { rows } = await pool.query('SELECT text FROM notes WHERE id = $1', [res.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('acheter du pain');
  });

  test('refuse une note vide avec un 400 et n\'écrit rien en base', async () => {
    const res = await request(app).post('/notes').send({ text: '   ' });

    expect(res.status).toBe(400);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM notes');
    expect(rows[0].n).toBe(0);
  });
});

describe('GET /notes', () => {
  test('renvoie les notes dans l\'ordre de création', async () => {
    await request(app).post('/notes').send({ text: 'première' });
    await request(app).post('/notes').send({ text: 'deuxième' });

    const res = await request(app).get('/notes');

    expect(res.status).toBe(200);
    expect(res.body.map((n) => n.text)).toEqual(['première', 'deuxième']);
  });
});
