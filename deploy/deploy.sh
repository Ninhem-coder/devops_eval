#!/usr/bin/env bash
# Déploie l'image IMAGE:TAG avec docker compose, vérifie /health (3 essais),
# et revient à l'image précédente (rollback) si la vérification échoue.
# Variables attendues : IMAGE (ex: ghcr.io/pseudo/devops_eval) et TAG (SHA court)
set -euo pipefail

HEALTH_URL="http://localhost:3000/health"
NEW_IMAGE="${IMAGE}:${TAG}"

# Vérifie /health jusqu'à 3 fois. Renvoie 0 si OK, 1 sinon.
healthcheck() {
  for essai in 1 2 3; do
    sleep 10   # laisse le temps à l'appli de démarrer
    if curl -fsS --max-time 5 "$HEALTH_URL"; then
      echo
      echo "Healthcheck OK (essai $essai/3)"
      return 0
    fi
    echo "Healthcheck en échec (essai $essai/3)"
  done
  return 1
}

# 1. On note l'image qui tourne actuellement, pour pouvoir y revenir
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' notes-app-1 2>/dev/null || true)"
echo "Image actuelle  : ${PREVIOUS_IMAGE:-aucune (premier déploiement)}"
echo "Nouvelle image  : $NEW_IMAGE"

# 2. On récupère la nouvelle image et on remplace le conteneur de l'appli
docker pull "$NEW_IMAGE"
APP_IMAGE="$NEW_IMAGE" docker compose up -d --no-build

# 3. Vérification post-déploiement
if healthcheck; then
  echo "Déploiement réussi : $NEW_IMAGE"
  exit 0
fi

# 4. Échec : rollback vers l'image précédente, et le job échoue
echo "ÉCHEC du healthcheck après 3 essais"
docker compose logs --tail 30 app || true

if [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$NEW_IMAGE" ]; then
  echo "ROLLBACK vers $PREVIOUS_IMAGE"
  # re-pull du SHA précédent (si l'image n'est pas sur le registry, on garde la copie locale)
  docker pull "$PREVIOUS_IMAGE" || echo "Pull impossible, utilisation de l'image locale"
  APP_IMAGE="$PREVIOUS_IMAGE" docker compose up -d --no-build
  if healthcheck; then
    echo "Rollback OK, l'ancienne version tourne de nouveau"
  else
    echo "Le rollback a aussi échoué"
  fi
else
  echo "Pas d'image précédente, rollback impossible"
fi

exit 1
