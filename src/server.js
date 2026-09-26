// Point d'entrée : prépare la base puis démarre le serveur HTTP.
const app = require('./app');
const { init } = require('./db');

const PORT = Number(process.env.PORT || 3000);

init()
  .then(() => {
    app.listen(PORT, () => console.log(`API démarrée sur le port ${PORT}`));
  })
  .catch((err) => {
    console.error('Impossible de se connecter à la base :', err.message);
    process.exit(1);
  });
