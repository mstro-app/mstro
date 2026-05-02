#!/usr/bin/env bash
set -euo pipefail

GITHUB_URL="https://github.com/mstro-app/mstro.git"

cd "$(git rev-parse --show-toplevel)"

git fetch "$GITHUB_URL" main
PARENT=$(git rev-parse FETCH_HEAD)
TREE=$(git rev-parse HEAD:cli)

if [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ]; then
  echo "cli/ is identical to github main — nothing to push."
  exit 0
fi

MSG=$(git log -1 --format=%B HEAD)
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
git push "$GITHUB_URL" "${COMMIT}:refs/heads/main"

echo "Pushed $COMMIT to $GITHUB_URL main."
