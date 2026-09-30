# API de notes : pipeline DevOps complet

[![CI](https://github.com/Ninhem-coder/devops_eval/actions/workflows/ci.yml/badge.svg)](https://github.com/Ninhem-coder/devops_eval/actions/workflows/ci.yml)
[![CD](https://github.com/Ninhem-coder/devops_eval/actions/workflows/cd.yml/badge.svg)](https://github.com/Ninhem-coder/devops_eval/actions/workflows/cd.yml)

Projet d'évaluation DevOps (ESIEA) : une petite API HTTP de notes en Node.js, conteneurisée avec Docker, testée par une CI GitHub Actions, puis construite, poussée sur GitHub Container Registry et déployée automatiquement sur une VM Debian par une CD. L'application expose ses métriques au format Prometheus, avec deux règles d'alerte.

```
 git push (branche) ──> pull request ──> CI : lint + test (Node 20/22 + Postgres) + build ──> ci-ok
                                                                                               │
                              merge sur main (bloqué tant que ci-ok n'est pas vert) <──────────┘
                                          │
                                          ▼
      CD : build + push ghcr.io (latest, SHA court, v1.0.0) ──> deploy sur la VM (self-hosted runner)
                                                                  pull ─> docker compose up ─> curl /health x3
                                                                                               │
                                                                        échec ─> rollback vers le SHA précédent
```

---

## Sommaire

- [Stack](#stack)
- [Lancer le projet en local](#lancer-le-projet-en-local)
- [L'API](#lapi)
- [Tests](#tests)
- [Docker](#docker)
- [CI](#ci-githubworkflowsciyml)
- [CD](#cd-githubworkflowscdyml)
- [Métriques et alertes](#métriques-et-alertes)
- [Sécurité](#sécurité)
- [Organisation du dépôt](#organisation-du-dépôt)

---

## Stack

| Rôle | Outil |
|---|---|
| Application | Node.js 22, Express 5 |
| Base de données | PostgreSQL 16 |
| Tests | Jest + Supertest, rapports JUnit (jest-junit) et coverage (lcov) |
| Lint | ESLint (code), yamllint (YAML) |
| Conteneurs | Docker (multi-stage, alpine), Docker Compose |
| CI / CD | GitHub Actions, runner self-hosted sur une VM Debian |
| Registry | GitHub Container Registry (ghcr.io) |
| Métriques | prom-client (format Prometheus), règles d'alerte Prometheus |

---

## Lancer le projet en local

### Prérequis

- Docker et Docker Compose (plugin `docker compose`)
- Node.js 20 ou 22 et npm, seulement pour lancer les tests et le lint hors Docker

### Démarrer l'application (une commande)

```bash
git clone https://github.com/Ninhem-coder/devops_eval.git
cd devops_eval
docker compose up -d --build
```

Vérifier que tout tourne :

```bash
docker compose ps                        # db et app doivent être "healthy"
curl http://localhost:3000/health        # {"status":"ok","db":"up"}
```

Utiliser l'API :

```bash
curl -X POST http://localhost:3000/notes \
  -H 'Content-Type: application/json' -d '{"text":"ma première note"}'
curl http://localhost:3000/notes
curl http://localhost:3000/metrics
```

Arrêter :

```bash
docker compose down        # garde les données
docker compose down -v     # supprime aussi le volume de la base
```

### Configuration (optionnel)

Sans fichier `.env`, des valeurs par défaut sont utilisées (utilisateur, mot de passe et base : `app`, port 3000). Pour les changer :

```bash
cp .env.example .env
# puis modifier .env (il est dans le .gitignore, il n'est jamais commité)
```

| Variable | Défaut | Rôle |
|---|---|---|
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `app` | identifiants de la base |
| `APP_PORT` | `3000` | port de l'API sur la machine |
| `DB_HOST_PORT` | `5432` | port de Postgres sur la machine (ouvert seulement sur 127.0.0.1) |
| `APP_IMAGE` | `notes-api:local` | image de l'API. La CD la remplace par l'image de ghcr.io |

---

## L'API

| Route | Réponse |
|---|---|
| `GET /health` | `200 {"status":"ok","db":"up"}` si la base répond à un `SELECT 1`, sinon `503 {"status":"error","db":"down"}` |
| `POST /notes` | body `{"text":"..."}`. `201` avec la note créée, `400` si le texte est vide ou le JSON mal formé |
| `GET /notes` | `200` avec la liste des notes |
| `GET /metrics` | métriques au format texte Prometheus |

`/health` interroge vraiment la base : une API qui tourne sans sa base ne sert à rien, donc le healthcheck doit le voir. C'est cet endpoint qu'utilisent le HEALTHCHECK Docker, le healthcheck du compose et la vérification post-déploiement de la CD.

---

## Tests

```bash
npm ci
docker compose up -d db     # le test a besoin d'une vraie base Postgres
npm test
```

Un test d'intégration (`tests/api.test.js`) qui vérifie un vrai comportement de l'application :

1. `POST /notes` renvoie bien **201** (code HTTP)
2. la réponse contient le texte envoyé (contenu de réponse)
3. la note est bien enregistrée : le test fait un `SELECT` directement dans Postgres (interaction avec un service)

Si la base est arrêtée ou si le code renvoie un autre statut, le test échoue.

Rapports générés dans `reports/` : `junit.xml` (JUnit) et `coverage/` (ouvrir `coverage/lcov-report/index.html`).

Lint :

```bash
npm run lint           # ESLint
yamllint --strict .    # tous les fichiers YAML
```

---

## Docker

### Dockerfile

- **Image de base précise** : `node:22.20.0-alpine` (jamais `latest`, variante alpine donc légère)
- **Multi-stage** : le stage `deps` installe les dépendances de production (`npm ci --omit=dev`), l'image finale ne récupère que `node_modules` et `src/`. Jest, Supertest et ESLint ne sont pas dans l'image.
- **Cache des couches** : `package.json` et `package-lock.json` sont copiés avant le code, le `npm ci` n'est refait que si les dépendances changent
- **Non-root** : `USER 1000:1000` (utilisateur `node` de l'image officielle). Le code appartient à root, l'application peut le lire mais pas le modifier.
- **HEALTHCHECK** : appelle `/health` avec le `fetch` intégré à Node (pas besoin d'installer curl)
- **`.dockerignore`** : exclut `.git`, `node_modules`, `tests`, `reports`, `.env`, les fichiers de CI...
- `GIT_SHA` est passé au build par la CD et affiché par la métrique `app_info`

Vérifications :

```bash
docker build -t notes-api:dev .
docker run --rm --entrypoint id notes-api:dev -u    # 1000, pas 0 (root)
docker images notes-api                             # taille de l'image
```

### docker-compose.yml

- 2 services : `db` (postgres:16.10-alpine, données dans le volume `db-data`) et `app`
- port de l'API mappé : `3000:3000`
- healthchecks cohérents : `pg_isready` pour la base, `/health` pour l'API, et `depends_on: condition: service_healthy` pour que l'API ne démarre que quand la base est prête
- l'API joint la base par le nom du service (`DB_HOST=db`)
- aucun mot de passe en dur : `${DB_PASSWORD:-app}` lu dans `.env`

---

## CI (`.github/workflows/ci.yml`)

Déclenchée sur chaque **pull request** et chaque **push sur main**. Permissions : `contents: read` uniquement.

```
lint ──────────┐
               ├──> build ──> ci-ok
test (20, 22) ─┘
```

| Job | Rôle | Timeout |
|---|---|---|
| `lint` | ESLint + yamllint sur tout le dépôt | 10 min |
| `test` | matrix Node **20** et **22**, service **Postgres** utilisé par le test, publication des rapports (`upload-artifact`) | 10 min |
| `build` | récupère les rapports (`download-artifact`), construit l'image Docker | 15 min |
| `ci-ok` | job final : vert seulement si lint, test et build sont verts | 5 min |

- **Protection de la branche main** : pull request obligatoire et check `ci-ok` requis. Le merge est bloqué tant que `ci-ok` n'est pas vert. (Pas d'approbation obligatoire : projet réalisé seul, GitHub interdit d'approuver sa propre PR.)
- `ci-ok` a `if: always()` : sinon, quand un job échoue, il serait "skipped" et GitHub le considérerait comme valide.
- **Cache** : cache natif de `setup-node` (`cache: npm`), clé calculée sur le `package-lock.json`. Au 2e run sur la même branche : `Cache hit for: node-cache-Linux-x64-npm-...` dans les logs.
- **Action locale réutilisable** : `.github/actions/setup-node-deps` (setup-node + cache, puis `npm ci`). Les jobs lint et test l'appellent en une ligne au lieu de dupliquer ces steps.

---

## CD (`.github/workflows/cd.yml`)

Déclenchée **après une CI verte sur main** (`workflow_run`), ou **manuellement** (`workflow_dispatch`, input `environment: production`). Permissions : `contents: read` et `packages: write`.

### build-push (runner GitHub)

Construit l'image du commit validé par la CI et la pousse sur **ghcr.io** avec 3 tags :

| Tag | Exemple | Usage |
|---|---|---|
| `latest` | `ghcr.io/ninhem-coder/devops_eval:latest` | dernière version |
| SHA court | `ghcr.io/ninhem-coder/devops_eval:387c032` | tag immuable, celui qui est déployé et qui sert au rollback |
| semver | `ghcr.io/ninhem-coder/devops_eval:v1.0.0` | version du `package.json` |

### deploy (self-hosted runner sur la VM)

Ne tourne que si `github.ref == refs/heads/main` ou via `workflow_dispatch`. Il lance `deploy/deploy.sh` :

1. note l'image qui tourne actuellement (pour le rollback)
2. `docker pull` de la nouvelle image (tag SHA) et `docker compose up -d` avec `APP_IMAGE` pointant dessus
3. vérification : `curl -f http://localhost:3000/health`, **3 essais** espacés de 10 s
4. si les 3 échouent : **rollback**, re-pull de l'image du SHA précédent, relance, et le job **échoue** (`exit 1`)

Stratégie : remplacement du conteneur sur une seule VM, avec vérification juste après et retour automatique à l'image précédente. C'est la stratégie la plus simple adaptée à une seule machine, et c'est celle qui correspond au rollback demandé (re-pull du SHA précédent).

**Rollback manuel** si un problème apparaît après un déploiement réussi : `git revert` du commit en cause, par une pull request. La CI puis la CD repassent et redéploient une version saine, et l'historique Git reste la source de vérité.

### Installer le runner sur la machine cible

Sur GitHub : **Settings > Actions > Runners > New self-hosted runner** (Linux x64), puis sur la VM, avec un utilisateur qui fait partie du groupe `docker` (pas root) :

```bash
mkdir ~/actions-runner && cd ~/actions-runner
# commandes curl / tar / ./config.sh affichées par GitHub
sudo ./svc.sh install $USER
sudo ./svc.sh start
```

Comme le dépôt est public : **Settings > Actions > General > Fork pull request workflows** réglé sur *Require approval for all outside collaborators*, pour qu'une PR venant d'un fork ne puisse pas exécuter de code sur la VM.

---

## Métriques et alertes

### `GET /metrics`

| Type | Métrique | Labels |
|---|---|---|
| Compteur | `http_requests_total` | `endpoint`, `code` |
| Histogramme | `http_request_duration_seconds` (buckets de 5 ms à 5 s) | `endpoint` |
| Jauge | `app_info` (vaut 1) | `version`, `sha` du commit déployé |

- `endpoint` = la route déclarée (`/notes`), pas l'URL brute, pour ne pas créer une série par URL. Une URL inconnue est comptée en `unmatched`.
- les appels à `/metrics` ne sont pas comptés.

```bash
curl -s http://localhost:3000/metrics | grep -E '^(http_requests_total|app_info)'
# http_requests_total{endpoint="/notes",code="201"} 1
# app_info{version="1.0.0",sha="387c032"} 1
```

### Règles d'alerte (`monitoring/alert_rules.yml`)

| Alerte | Expression | Seuil | for |
|---|---|---|---|
| `TauxErreurs5xxEleve` | `sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` | > 5 % | 5 min |
| `LatenceP95Degradee` | `histogram_quantile(0.95, sum by (le, endpoint) (rate(http_request_duration_seconds_bucket[5m])))` | > 500 ms | 10 min |

Justification des valeurs :

- **5 % de 5xx** : l'API ne renvoie normalement quasiment aucune 5xx (les erreurs du client sont des 4xx). 1 requête sur 20 en erreur serveur signale un vrai problème (base injoignable, mauvais déploiement). `for: 5m` évite d'alerter sur un pic court, comme les quelques secondes de redémarrage du conteneur pendant un déploiement.
- **p95 à 500 ms** : chaque route fait une requête SQL simple, le p95 normal est de quelques millisecondes. 500 ms est une dégradation nette et visible, et c'est une borne de bucket donc le calcul est précis. `for: 10m` : une lenteur passagère gêne moins qu'une erreur, on n'alerte que si elle dure.

Vérifier la syntaxe des règles avec l'outil officiel de Prometheus :

```bash
docker run --rm -v "$PWD/monitoring:/rules" --entrypoint promtool \
  prom/prometheus:v3.5.0 check rules /rules/alert_rules.yml
# SUCCESS: 2 rules found
```

---

## Sécurité

- Le seul secret utilisé est **`GITHUB_TOKEN`**, fourni automatiquement par GitHub à chaque run, limité au dépôt et à la durée du job, avec des droits réduits par `permissions:` (moindre privilège). Il n'est jamais affiché : GitHub le masque dans les logs et `docker/login-action` se déconnecte en fin de job.
- Aucun mot de passe dans le code, le Dockerfile ou le compose : variables d'environnement et `.env` non commité (seul `.env.example` est versionné).
- Conteneur non-root, image minimale, dépendances de dev exclues de l'image.
- Port Postgres ouvert uniquement sur `127.0.0.1`.
- Branche `main` protégée : aucun code ne l'atteint sans pull request et CI verte.

---

## Organisation du dépôt

```
.
├── .github/
│   ├── actions/setup-node-deps/action.yml   # action locale : setup Node + cache + npm ci
│   └── workflows/
│       ├── ci.yml                           # lint, test (matrix + postgres), build, ci-ok
│       └── cd.yml                           # build + push ghcr.io, deploy sur la VM
├── deploy/deploy.sh                         # déploiement, healthcheck x3, rollback
├── monitoring/alert_rules.yml               # règles d'alerte Prometheus
├── src/
│   ├── app.js                               # routes Express
│   ├── db.js                                # connexion Postgres
│   ├── metrics.js                           # compteur, histogramme, jauge, /metrics
│   └── server.js                            # point d'entrée
├── tests/api.test.js                        # test d'intégration
├── docs/preuves/                            # captures (cache HIT, etc.)
├── Dockerfile
├── .dockerignore
├── docker-compose.yml
├── .env.example
├── .yamllint.yml
├── eslint.config.js
├── ETAPES.md                                # étapes du projet et commandes pour tout vérifier
└── package.json
```

`ETAPES.md` détaille chaque étape du projet avec les commandes pour la tester et la prouver (healthcheck qui passe en 503, test qui échoue si on casse le code, cache HIT, rollback, etc.).
