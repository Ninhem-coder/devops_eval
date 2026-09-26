# Étapes du projet

Notes de suivi : ce qui a été fait à chaque étape, et les commandes pour le tester soi-même.
Les commandes sont pour Linux / macOS (ou la VM Debian). Il faut Node 20 ou 22 et Docker.

Avancement :

- [x] 1. Application (API + Postgres)
- [x] 2. Tests automatisés
- [x] 3. Dockerfile
- [x] 4. docker-compose
- [x] 5. Action locale réutilisable
- [ ] 6. CI (ci.yml)
- [ ] 7. CD (cd.yml) + déploiement sur la VM
- [ ] 8. Métriques /metrics + alertes
- [ ] 9. README, zip, collaborateur

---

## Préparation (à faire une fois)

Pour les étapes 1 à 3, on a juste besoin d'une base Postgres. On lance seulement le service `db` du docker-compose (étape 4) :

```bash
docker compose up -d db
```

La base est accessible sur `localhost:5432` (user `app`, mot de passe `app`, base `app`).

Puis on installe les dépendances du projet :

```bash
npm install
```

Pour tout arrêter à la fin : `docker compose down` (ajouter `-v` pour effacer aussi les données)

---

## Étape 1 : l'application

Une petite API de notes en Node.js (Express 5) qui stocke les données dans Postgres.

Fichiers :

- `src/db.js` : connexion à Postgres, config lue dans les variables d'environnement (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME), création de la table `notes`
- `src/app.js` : les routes
- `src/server.js` : démarre le serveur sur le port 3000

Routes :

| Route | Ce qu'elle fait |
|---|---|
| GET /health | fait un `SELECT 1` sur la base. 200 si ça répond, 503 sinon |
| POST /notes | crée une note (`{"text": "..."}`). 201, ou 400 si le texte est vide |
| GET /notes | liste les notes |

Pourquoi `/health` interroge la base : si l'API tourne mais que la base est morte, l'appli ne sert à rien. Un health qui répond toujours "ok" ne voudrait rien dire.

Pourquoi app.js et server.js sont séparés : les tests importent `app.js` directement, sans avoir à lancer le serveur.

### Tester

Lancer l'API (dans un premier terminal) :

```bash
npm start
```

Dans un deuxième terminal :

```bash
# santé -> 200
curl -i http://localhost:3000/health

# créer une note -> 201
curl -i -X POST http://localhost:3000/notes \
  -H 'Content-Type: application/json' -d '{"text":"ma premiere note"}'

# note vide -> 400
curl -i -X POST http://localhost:3000/notes \
  -H 'Content-Type: application/json' -d '{"text":""}'

# lister -> 200 avec la note
curl http://localhost:3000/notes
```

### Prouver que le health est honnête

```bash
docker compose stop db
curl -i http://localhost:3000/health     # -> 503, {"status":"error","db":"down"}

docker compose start db
sleep 3
curl -i http://localhost:3000/health     # -> 200 de nouveau
```

L'API ne doit pas planter pendant la coupure. Au début elle plantait : la librairie `pg` lève une erreur quand la base ferme une connexion, et sans `pool.on('error', ...)` Node s'arrêtait. C'est corrigé dans `db.js`.

---

## Étape 2 : les tests

Fichier : `tests/api.test.js`. Outils : jest (lance les tests) et supertest (envoie des requêtes HTTP à l'app).

Ce sont des tests d'intégration, ils utilisent une vraie base Postgres :

1. GET /health renvoie 200 et `db: up`
2. POST /notes renvoie 201, puis on vérifie directement dans Postgres que la note est bien enregistrée
3. POST /notes avec un texte vide renvoie 400 et rien n'est écrit en base
4. GET /notes renvoie les notes dans l'ordre

Avant chaque test la table est vidée (`TRUNCATE`), pour que les tests ne dépendent pas les uns des autres.

### Tester

Postgres doit tourner (voir Préparation). Pas besoin de lancer l'API.

```bash
npm test
```

Résultat attendu : `Tests: 4 passed, 4 total` et un tableau de couverture.

Les rapports sont générés dans `reports/` :

- `reports/junit.xml` : résultat des tests au format JUnit
- `reports/coverage/` : couverture de code (ouvrir `reports/coverage/lcov-report/index.html` dans un navigateur)

La CI les publiera en artifacts plus tard.

### Prouver que les tests testent vraiment quelque chose

```bash
docker compose stop db
npm test          # -> les 4 tests échouent
docker compose start db
```

Autre façon : dans `src/app.js`, remplacer `res.status(201)` par `res.status(200)` et relancer `npm test`. Le test du POST échoue. Remettre 201 après.

---

## Étape 3 : le Dockerfile

Fichiers : `Dockerfile` et `.dockerignore`.

Ce que demande le sujet et comment c'est fait :

| Exigence | Dans le Dockerfile |
|---|---|
| Image de base précise, pas latest | `node:22.20.0-alpine` (version exacte, variante alpine donc légère) |
| Build multi-stage | stage `deps` qui fait le `npm ci`, puis stage `runtime` qui ne récupère que `node_modules` et le code |
| Pas root | `USER 1000:1000`, c'est l'utilisateur `node` qui existe déjà dans l'image officielle |
| HEALTHCHECK réel | appelle `/health`, qui interroge la base. Base coupée = conteneur unhealthy |
| .dockerignore avec .git | exclut `.git`, `node_modules`, `tests`, `reports`, les `.md`, `.env`... |

Détails :

- `npm ci --omit=dev` : on n'installe pas jest et supertest dans l'image de prod, ils ne servent qu'aux tests.
- On copie `package.json` et `package-lock.json` avant le code : tant que les dépendances ne changent pas, Docker garde le `npm ci` en cache et le build est beaucoup plus rapide.
- Le code appartient à root et l'appli tourne avec `node` : elle peut lire son code mais pas le modifier.
- Le healthcheck utilise `node -e "fetch(...)"` au lieu de curl, comme ça pas besoin d'installer curl dans l'image.
- `server.js` gère maintenant `SIGTERM` : quand on fait `docker stop`, l'appli ferme ses connexions et s'arrête tout de suite, au lieu d'attendre 10 s que Docker la tue.

Le Dockerfile passe hadolint (linter de Dockerfile) sans aucun avertissement.

### Tester

Postgres doit tourner (voir Préparation). On branche le conteneur de l'API sur le réseau du compose (`notes_default`) pour qu'il voie la base :

```bash
docker build -t notes-api:dev .

docker run -d --name notes-api --network notes_default -p 3000:3000 \
  -e DB_HOST=db -e DB_USER=app -e DB_PASSWORD=app -e DB_NAME=app \
  notes-api:dev

curl http://localhost:3000/health
```

Si le `docker build` dit que l'image `node:22.20.0-alpine` n'existe pas, prendre une autre version 22 en alpine sur hub.docker.com/_/node et changer la ligne `ARG NODE_IMAGE`.

### Prouver chaque point

```bash
# pas root -> affiche node et 1000
docker exec notes-api whoami
docker exec notes-api id -u

# le healthcheck marche -> healthy (attendre ~15 s après le lancement)
docker inspect --format '{{.State.Health.Status}}' notes-api

# le healthcheck reflète l'état réel : on coupe la base
docker compose stop db
sleep 50
docker inspect --format '{{.State.Health.Status}}' notes-api   # -> unhealthy
docker compose start db
sleep 20
docker inspect --format '{{.State.Health.Status}}' notes-api   # -> healthy

# multi-stage + omit=dev : pas de jest dans l'image -> rien ne s'affiche
docker exec notes-api ls node_modules | grep -E '^(jest|supertest)$'

# .dockerignore : pas de .git ni de tests dans l'image
docker exec notes-api ls -a /app

# taille de l'image
docker images notes-api

# arrêt propre -> "SIGTERM reçu, arrêt propre" dans les logs, et ça prend moins d'une seconde
time docker stop notes-api
docker logs notes-api
```

Nettoyage : `docker rm -f notes-api`

---

## Étape 4 : docker-compose

Fichiers : `docker-compose.yml` et `.env.example`.

Deux services :

- `db` : Postgres 16 (version précise, alpine). Les données sont dans un volume `db-data` pour ne pas les perdre au redémarrage.
- `app` : notre API, construite à partir du Dockerfile.

Ce que demande le sujet :

| Exigence | Dans le compose |
|---|---|
| Deux services minimum | `db` et `app` |
| Port de l'appli exposé et mappé | `3000:3000` (changeable avec `APP_PORT`) |
| Healthcheck cohérent | `db` : `pg_isready`. `app` : appelle `/health`, qui interroge la base |

Détails :

- `depends_on` avec `condition: service_healthy` : l'API attend que Postgres soit vraiment prêt avant de démarrer, pas juste que le conteneur soit lancé. Les deux healthchecks sont donc liés : la base doit être healthy pour que l'API démarre, et l'API n'est healthy que si la base répond.
- Dans le réseau du compose, chaque service est joignable par son nom : l'API se connecte à `DB_HOST=db`.
- Le port de Postgres n'est ouvert que sur `127.0.0.1` : on peut lancer `npm test` depuis la machine, mais personne sur le réseau ne peut s'y connecter.
- Les mots de passe ne sont pas en dur : `${DB_PASSWORD:-app}` prend la valeur du fichier `.env` s'il existe, sinon `app`. Le `.env` est dans le `.gitignore`, seul `.env.example` est commité.
- `image: ${APP_IMAGE:-notes-api:local}` : en local l'image est construite, et au déploiement (étape 7) on pourra réutiliser le même fichier avec l'image de ghcr.io.
- `restart: unless-stopped` : si l'appli plante ou si la machine redémarre, Docker la relance.

### Tester

Tout lancer en une commande :

```bash
docker compose up -d --build
```

Puis :

```bash
docker compose ps                 # les 2 services doivent être "healthy"
curl http://localhost:3000/health
curl -X POST http://localhost:3000/notes \
  -H 'Content-Type: application/json' -d '{"text":"depuis compose"}'
curl http://localhost:3000/notes
docker compose logs app
```

### Prouver

```bash
# l'ordre de démarrage : l'API attend que la base soit healthy
docker compose down
docker compose up -d
docker compose ps        # app reste en "Created"/"Waiting" tant que db n'est pas healthy

# les données survivent à un redémarrage (grâce au volume)
docker compose restart
curl http://localhost:3000/notes  # la note est toujours là

# healthcheck cohérent : on coupe la base, l'API passe unhealthy
docker compose stop db
sleep 50
docker compose ps app    # -> unhealthy
docker compose start db
sleep 20
docker compose ps        # -> tout redevient healthy

# vérifier la syntaxe du fichier
docker compose config -q && echo OK
```

Arrêter : `docker compose down` (avec `-v` pour supprimer aussi les données).

---

## Étape 5 : l'action locale réutilisable

Fichier : `.github/actions/setup-node-deps/action.yml`

C'est une "composite action" : un petit bloc de steps qu'on écrit une fois et que les workflows appellent avec une seule ligne. Sans elle, chaque job de la CI (lint, test...) devrait répéter les mêmes 3 steps.

Les 3 steps :

1. `actions/setup-node@v4` installe Node (version passée en paramètre, 22 par défaut) avec `cache: npm`, le cache natif de setup-node
2. affiche dans les logs si le cache a été retrouvé ou non (`Cache npm : HIT` ou `MISS`)
3. `npm ci` installe exactement les versions du `package-lock.json`

Ce que demande le sujet (3.4) : une action locale d'au moins deux steps, appelée par les workflows sans dupliquer le bloc. C'est le cas, on en a trois.

Détails :

- Le cache est rangé sous une clé calculée à partir du `package-lock.json`. Tant qu'il ne change pas, la clé est la même et le cache est réutilisé. Si on ajoute une dépendance, la clé change et le cache est refait.
- Ce qui est mis en cache, c'est le dossier de téléchargement de npm (`~/.npm`), pas `node_modules`. `npm ci` supprime toujours `node_modules`, donc c'est plus fiable de cacher les téléchargements : npm ne retélécharge rien, il installe depuis le cache.
- `npm ci` plutôt que `npm install` : il n'a pas le droit de modifier le `package-lock.json`, et il échoue si le lock n'est pas cohérent avec le `package.json`. En CI, on veut exactement les mêmes versions à chaque fois.
- L'action a un paramètre `node-version`, ce qui permet de l'utiliser avec la matrix Node 20 / 22 dans le job de test.

### Utilisation dans un workflow

```yaml
steps:
  - uses: actions/checkout@v4          # obligatoire avant : l'action est dans le dépôt
  - uses: ./.github/actions/setup-node-deps
    with:
      node-version: 22
```

### Tester / prouver

L'action ne se lance pas toute seule, elle sera testée avec la CI (étape 6). La preuve du cache HIT se fera là-bas :

- premier run de la CI : dans le log du step "Etat du cache npm" -> `Cache npm : MISS`
- deuxième run sur la même branche (re-run ou nouveau push sans toucher au package-lock) -> `Cache npm : HIT`, et dans le step "Installer Node.js" une ligne `Cache restored from key: ...`

Vérifier la syntaxe en local :

```bash
pip install yamllint     # ou : sudo apt-get install -y yamllint
yamllint .github/actions/setup-node-deps/action.yml
```
