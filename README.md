# devops_eval

[![CI](https://github.com/Ninhem-coder/devops_eval/actions/workflows/ci.yml/badge.svg)](https://github.com/Ninhem-coder/devops_eval/actions/workflows/ci.yml)
[![CD](https://github.com/Ninhem-coder/devops_eval/actions/workflows/cd.yml/badge.svg)](https://github.com/Ninhem-coder/devops_eval/actions/workflows/cd.yml)

Évaluation du cours DevOps (ESIEA)

## Application

Fonctionnement

* API de notes en Node.js 22 (Express 5)
* Les notes sont stockées dans une base PostgreSQL
* Routes : `GET /health`, `POST /notes`, `GET /notes`, `GET /metrics`
* `/health` fait un `SELECT 1` sur la base : 200 si elle répond, 503 sinon

## Docker

Dockerfile

* Port 3000
* Image précise : `node:22.20.0-alpine`
* Build multi-stage : les dépendances sont installées dans un premier stage, l'image finale ne garde que le nécessaire (pas de dépendances de dev)
* Utilisateur non-root : `node` (uid 1000)
* Healthcheck sur `/health`, toutes les 15 s
* `.dockerignore` qui exclut `.git`, `node_modules`, les tests, `.env`...

Docker Compose

* Deux services : l'API (source : Dockerfile) et PostgreSQL (`postgres:16.10-alpine`)
* Port mappé (3000:3000)
* Deux healthchecks : `pg_isready` pour la base, `/health` pour l'API
* L'API ne démarre que quand la base est healthy (`depends_on: condition: service_healthy`)
* Mots de passe lus dans un `.env` (non commité), valeurs par défaut sinon

## Workflow CI

`.github/workflows/ci.yml`, sur chaque pull request et push sur main

Lint

* ESLint sur le code JavaScript
* yamllint sur tous les fichiers YAML (config dans `.yamllint.yml`)

Test (jest)

* Test d'intégration avec Jest + Supertest : crée une note via l'API, vérifie le code 201, le contenu de la réponse et que la note est bien dans Postgres
* Matrice sur Node 20 et 22
* Service PostgreSQL démarré pour le test
* Mise en cache des dépendances npm (cache natif de setup-node)
* Upload des rapports JUnit et coverage avec upload-artifact

Build

* Récupère les rapports avec download-artifact
* Build de l'image Docker

ci-ok

* Job final, vert seulement si lint, test et build sont verts
* Obligatoire pour merger sur main (protection de branche)

Les jobs utilisent l'action locale `.github/actions/setup-node-deps` (setup Node + cache + `npm ci`).

## Workflow CD

`.github/workflows/cd.yml`, après une CI verte sur main ou via workflow_dispatch

Publish

* Build de l'image et push sur le registry GHCR (connexion avec `GITHUB_TOKEN`)
* Trois tags : `latest`, SHA court du commit et semver (`v` + version du `package.json`)

Deploy

* Ne s'exécute que sur main ou via workflow_dispatch
* Déploiement réel sur la machine cible (runner self-hosted) via docker compose, avec l'image du SHA
* Health check : curl sur `/health` avec 3 essais
* Si le healthcheck échoue, le job échoue et l'image du SHA précédent est re-pull (rollback)
* Script : `deploy/deploy.sh`

## Runner GitHub Actions

* Tourne sur une VM Debian, installé en service
* Utilisateur non-root, membre du groupe docker

## Monitoring

* Endpoint `/metrics` au format Prometheus
* `http_requests_total` : compteur de requêtes (labels endpoint et code)
* `http_request_duration_seconds` : histogramme de la durée des requêtes par route (p95 / p99)
* `app_info` : jauge avec la version et le SHA déployés
* Règles d'alerte dans `monitoring/alert_rules.yml` :
  * taux de 5xx > 5 % sur 5 min, pendant 5 min
  * latence p95 > 500 ms, pendant 10 min

## Mise en place en local (avec docker)

```
git clone https://github.com/Ninhem-coder/devops_eval.git
cd devops_eval

docker compose up --build -d
```

L'application est disponible sur http://localhost:3000
Pour arrêter : `docker compose down` (-v pour supprimer les données sql)

Lancer les tests :

```
npm ci
docker compose up -d db
npm test
```

Le détail de chaque étape et les commandes pour tout vérifier sont dans `ETAPES.md`.
