# Étapes du projet

Notes de suivi : ce qui a été fait à chaque étape, et les commandes pour le tester soi-même.
Les commandes sont pour Linux (la VM Debian). Il faut Node 20 ou 22 et Docker.

Avancement :

- [x] 1. Application (API + Postgres)
- [x] 2. Test automatisé
- [x] 3. Dockerfile
- [x] 4. docker-compose
- [x] 5. Action locale réutilisable
- [x] 6. CI (ci.yml)
- [ ] 7. CD (cd.yml) + déploiement sur la VM
- [ ] 8. Métriques /metrics + alertes
- [ ] 9. README, zip, collaborateur

---

## Préparation (à faire une fois)

Pour les étapes 1 à 3, on a juste besoin de la base Postgres. On lance seulement le service `db` du docker-compose :

```bash
docker compose up -d db
```

La base est accessible sur `localhost:5432` (user `app`, mot de passe `app`, base `app`).

Puis on installe les dépendances du projet :

```bash
npm ci
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

Pourquoi app.js et server.js sont séparés : le test importe `app.js` directement, sans avoir à lancer le serveur.

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

## Étape 2 : le test automatisé

Fichier : `tests/api.test.js`. Outils : jest (lance le test) et supertest (envoie des requêtes HTTP à l'app).

Le sujet demande au moins un test qui vérifie un vrai comportement. Il y en a un, et il coche les 3 exemples donnés dans le sujet :

| Ce que demande le sujet | Dans le test |
|---|---|
| code de retour HTTP | `expect(res.status).toBe(201)` |
| contenu de réponse | `expect(res.body.text).toBe('acheter du pain')` |
| interaction avec un service | `SELECT` direct dans Postgres pour vérifier que la note est bien enregistrée |

C'est un test d'intégration : il utilise une vraie base Postgres (en local celle du compose, en CI le `services: postgres`). La table est vidée au début (`TRUNCATE`) pour que le test donne toujours le même résultat.

### Tester

Postgres doit tourner (voir Préparation). Pas besoin de lancer l'API.

```bash
npm test
```

Résultat attendu : `Tests: 1 passed, 1 total` et un tableau de couverture.

Les rapports sont générés dans `reports/` :

- `reports/junit.xml` : résultat du test au format JUnit
- `reports/coverage/` : couverture de code (ouvrir `reports/coverage/lcov-report/index.html` dans un navigateur)

La CI les publie en artifacts.

### Prouver que le test teste vraiment quelque chose

```bash
docker compose stop db
npm test          # -> le test échoue
docker compose start db
```

Autre façon : casser le code et voir le test échouer.

```bash
sed -i 's/res.status(201)/res.status(200)/' src/app.js
npm test          # -> échoue : Expected 201, Received 200
sed -i 's/res.status(200).json(rows\[0\])/res.status(201).json(rows[0])/' src/app.js
npm test          # -> repasse
```

---

## Étape 3 : le Dockerfile

Fichiers : `Dockerfile` et `.dockerignore`.

| Exigence du sujet | Dans le Dockerfile |
|---|---|
| Image de base précise, pas latest | `node:22.20.0-alpine` (version exacte, variante alpine donc légère) |
| Build multi-stage | stage `deps` qui fait le `npm ci`, puis stage `runtime` qui ne récupère que `node_modules` et le code |
| Pas root | `USER 1000:1000`, c'est l'utilisateur `node` qui existe déjà dans l'image officielle |
| HEALTHCHECK réel | appelle `/health`, qui interroge la base. Base coupée = conteneur unhealthy |
| .dockerignore avec .git | exclut `.git`, `node_modules`, `tests`, `reports`, `.env`... |

Détails :

- `npm ci --omit=dev` : on n'installe pas jest et supertest dans l'image, ils ne servent qu'aux tests.
- On copie `package.json` et `package-lock.json` avant le code : tant que les dépendances ne changent pas, Docker garde le `npm ci` en cache et le build est plus rapide.
- Le healthcheck utilise `node -e "fetch(...)"` au lieu de curl, comme ça pas besoin d'installer curl dans l'image.

### Tester

La base doit tourner (voir Préparation). On branche le conteneur de l'API sur le réseau du compose (`notes_default`) pour qu'il voie la base :

```bash
docker build -t notes-api:dev .

docker run -d --name notes-api --network notes_default -p 3000:3000 \
  -e DB_HOST=db -e DB_USER=app -e DB_PASSWORD=app -e DB_NAME=app \
  notes-api:dev

curl http://localhost:3000/health
```

Si le `docker build` dit que l'image `node:22.20.0-alpine` n'existe pas, prendre une autre version 22 en alpine sur hub.docker.com/_/node et changer les deux lignes `FROM`.

### Prouver chaque point

```bash
# pas root -> affiche 1000
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

# .dockerignore : pas de .git ni de tests dans l'image
docker exec notes-api ls -a /app

# multi-stage : taille de l'image
docker images notes-api
```

Nettoyage : `docker rm -f notes-api`

---

## Étape 4 : docker-compose

Fichiers : `docker-compose.yml` et `.env.example`.

Deux services :

- `db` : Postgres 16 (version précise, alpine). Les données sont dans un volume `db-data` pour ne pas les perdre au redémarrage.
- `app` : notre API, construite à partir du Dockerfile.

| Exigence du sujet | Dans le compose |
|---|---|
| Deux services minimum | `db` et `app` |
| Port de l'appli exposé et mappé | `3000:3000` (changeable avec `APP_PORT`) |
| Healthcheck cohérent | `db` : `pg_isready`. `app` : appelle `/health`, qui interroge la base |

Détails :

- `depends_on` avec `condition: service_healthy` : l'API attend que Postgres soit vraiment prêt avant de démarrer. Les deux healthchecks sont liés : la base doit être healthy pour que l'API démarre, et l'API n'est healthy que si la base répond.
- Dans le réseau du compose, chaque service est joignable par son nom : l'API se connecte à `DB_HOST=db`.
- Le port de Postgres n'est ouvert que sur `127.0.0.1` : on peut lancer `npm test` depuis la machine, mais personne sur le réseau ne peut s'y connecter.
- Les mots de passe ne sont pas en dur : `${DB_PASSWORD:-app}` prend la valeur du fichier `.env` s'il existe, sinon `app`. Le `.env` est dans le `.gitignore`, seul `.env.example` est commité.
- `image: ${APP_IMAGE:-notes-api:local}` : en local l'image est construite, et au déploiement (étape 7) on réutilise le même fichier avec l'image de ghcr.io.

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
```

### Prouver

```bash
# healthcheck cohérent : on coupe la base, l'API passe unhealthy
docker compose stop db
sleep 50
docker compose ps app    # -> unhealthy
docker compose start db
sleep 20
docker compose ps        # -> tout redevient healthy
```

Arrêter : `docker compose down` (avec `-v` pour supprimer aussi les données).

---

## Étape 5 : l'action locale réutilisable

Fichier : `.github/actions/setup-node-deps/action.yml`

C'est une "composite action" : un bloc de steps qu'on écrit une fois et que les jobs de la CI appellent avec une seule ligne, au lieu de le répéter dans chaque job.

Les 2 steps :

1. `actions/setup-node@v4` installe Node (version en paramètre, 22 par défaut) avec `cache: npm`, le cache natif de setup-node
2. `npm ci` installe exactement les versions du `package-lock.json`

Détails :

- La clé du cache est calculée à partir du `package-lock.json`. Tant qu'il ne change pas, le cache est réutilisé (HIT). Si on ajoute une dépendance, la clé change (MISS) et le cache est refait.
- Ce qui est mis en cache, c'est le dossier de téléchargement de npm (`~/.npm`), pas `node_modules`, parce que `npm ci` supprime toujours `node_modules` avant d'installer.
- Le paramètre `node-version` permet de l'utiliser avec la matrix Node 20 / 22.

### Utilisation dans un workflow

```yaml
steps:
  - uses: actions/checkout@v4          # obligatoire avant : l'action est dans le dépôt
  - uses: ./.github/actions/setup-node-deps
    with:
      node-version: 22
```

---

## Étape 6 : la CI

Fichiers : `.github/workflows/ci.yml`, `.yamllint.yml`, `eslint.config.js` (et le script `npm run lint` dans `package.json`).

Déclenchement : à chaque pull request et à chaque push sur `main`.

```
lint ─────┐
          ├──> build ──> ci-ok
test ─────┘
 (Node 20 et 22)
```

| Job | Ce qu'il fait |
|---|---|
| `lint` | ESLint sur le code JS, yamllint sur tous les YAML |
| `test` | matrix Node 20 / 22, avec un vrai Postgres en `services:`. Lance `npm test` et publie `reports/` (JUnit + coverage) en artifact |
| `build` | attend lint et test, télécharge les rapports (download-artifact), construit l'image Docker |
| `ci-ok` | job final, vert seulement si les 3 autres sont verts. C'est lui qu'on rend obligatoire pour merger sur main |

| Exigence du sujet | Où |
|---|---|
| ci.yml sur pull_request et push main | bloc `on:` |
| permissions explicites, moindre privilège | `permissions: contents: read` (la CI ne fait que lire le code) |
| 4 jobs lint / test / build / ci-ok | les 4 jobs |
| matrix 2 versions, un échec fait échouer le job | `strategy.matrix.node: [20, 22]` |
| service utilisé vraiment | `services: postgres`, le test écrit et relit dans cette base |
| cache des dépendances, HIT au 2e run | cache natif de setup-node dans l'action locale |
| rapports publiés et récupérés par un job suivant | `upload-artifact` dans test, `download-artifact` dans build |
| timeout-minutes sur chaque job | présent sur les 4 jobs |
| lint des YAML | `yamllint --strict .` dans le job lint |

Détails :

- `if: always()` sur `ci-ok` : sans ça, si un job échoue, ci-ok serait "skipped" (gris) au lieu de rouge. Et GitHub considère un job skipped comme OK pour la protection de branche, donc le merge passerait.
- `if: always()` sur l'upload des rapports : on veut le rapport surtout quand les tests échouent.
- Le lint a trouvé une vraie erreur dans `app.js` (variable `err` inutilisée), corrigée.

### Lancer les mêmes vérifications en local

```bash
npm ci
npm run lint                       # ESLint
sudo apt-get install -y yamllint
yamllint --strict .                # lint des YAML
docker compose up -d db && npm test
docker build -t notes-api:ci .
```

### Mettre en place sur GitHub

1. Pousser :

```bash
git add .
git commit -m "ci: ajout du pipeline lint, test, build et ci-ok"
git push
```

2. Onglet **Actions** du dépôt : le workflow CI se lance, les 5 cases (lint, test Node 20, test Node 22, build, ci-ok) doivent passer au vert.

3. Bloquer le merge si ci-ok est rouge : **Settings > Branches > Add classic branch protection rule**
   - Branch name pattern : `main`
   - cocher **Require a pull request before merging**
   - cocher **Require status checks to pass before merging** et ajouter `ci-ok`
   - enregistrer

   Le check `ci-ok` n'apparaît dans la liste qu'après un premier run de la CI. À partir de là, on ne pousse plus directement sur main : on passe par une branche et une pull request.

### Prouver

**Cache HIT** : dans Actions, ouvrir le dernier run et cliquer sur "Re-run all jobs". Dans le nouveau run, job lint ou test, step "Installer Node.js" : ligne `Cache restored from key: ...`. Au tout premier run il y avait à la place `... cache is not found`.

**Artifacts** : en bas de la page du run, section Artifacts : `test-reports-node-20` et `test-reports-node-22`. Dans le job build, step "Afficher les rapports récupérés", on voit les fichiers téléchargés.

**Un test qui casse bloque le merge** :

```bash
git checkout -b test-casse
sed -i 's/res.status(201)/res.status(200)/' src/app.js
git commit -am "test: casser volontairement le code (à ne pas merger)"
git push -u origin test-casse
```

Sur GitHub, ouvrir une pull request de `test-casse` vers `main` : le test échoue sur les 2 cases de la matrix, build est skipped, ci-ok est rouge et le bouton Merge est bloqué. Ensuite fermer la PR sans merger et supprimer la branche :

```bash
git checkout main
git branch -D test-casse
git push origin --delete test-casse
```
