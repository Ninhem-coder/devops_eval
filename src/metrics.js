// Métriques Prometheus de l'application, exposées sur GET /metrics
const client = require('prom-client');

const register = new client.Registry();

// Compteur : nombre de requêtes reçues, par route et par code HTTP
const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requetes HTTP recues',
  labelNames: ['endpoint', 'code'],
  registers: [register],
});

// Histogramme : durée des requêtes, par route (sert à calculer p95 / p99)
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree de traitement des requetes HTTP, en secondes',
  labelNames: ['endpoint'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Jauge : version et SHA du commit déployé (la valeur vaut toujours 1, l'info est dans les labels)
const appInfo = new client.Gauge({
  name: 'app_info',
  help: 'Version et SHA du commit actuellement deploye',
  labelNames: ['version', 'sha'],
  registers: [register],
});
appInfo.set(
  { version: require('../package.json').version, sha: process.env.GIT_SHA || 'dev' },
  1
);

// Middleware : chronomètre chaque requête et la compte quand la réponse est envoyée
function metricsMiddleware(req, res, next) {
  if (req.path === '/metrics') return next(); // on ne compte pas les lectures de /metrics
  const stopTimer = httpDuration.startTimer();
  res.on('finish', () => {
    // la route déclarée (/notes) et pas l'URL brute, sinon une série par URL différente
    const endpoint = req.route ? req.route.path : 'unmatched';
    httpRequests.inc({ endpoint, code: res.statusCode });
    stopTimer({ endpoint });
  });
  next();
}

// Route GET /metrics : renvoie toutes les métriques au format texte Prometheus
async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
}

module.exports = { metricsMiddleware, metricsHandler };
