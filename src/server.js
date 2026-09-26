// Point d'entrée : prépare la base puis démarre le serveur HTTP.
const app = require('./app');
const { pool, init } = require('./db');

const PORT = Number(process.env.PORT || 3000);

init()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`API démarrée sur le port ${PORT}`));

    // docker stop envoie SIGTERM. Sans ce handler, Node (PID 1 dans le conteneur)
    // l'ignore et Docker attend 10 s avant de le tuer brutalement.
    process.on('SIGTERM', () => {
      console.log('SIGTERM reçu, arrêt propre');
      server.close(() => pool.end().then(() => process.exit(0)));
    });
  })
  .catch((err) => {
    console.error('Impossible de se connecter à la base :', err.message);
    process.exit(1);
  });
