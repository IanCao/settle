#!/usr/bin/env bash
# Publish app/ to GitHub Pages.
#
# The site is served from the gh-pages branch, whose tree is exactly app/ plus a
# .nojekyll marker. Nothing is copied by hand: the branch is rebuilt from the
# current app/ tree on every run, so what is deployed cannot drift from what is
# committed.
#
#   bash scripts/publish_app.sh

set -euo pipefail

cd "$(dirname "$0")/.."

git rev-parse --verify main:app >/dev/null || {
  echo "app/ is not committed on main - commit it first" >&2
  exit 1
}

export GIT_INDEX_FILE
GIT_INDEX_FILE="$(mktemp)"
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

git read-tree main:app
blob=$(printf '' | git hash-object -w --stdin)
git update-index --add --cacheinfo 100644,"$blob",.nojekyll
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -m "Publish the Settle web client")

echo "publishing $commit"
git push origin "$commit:refs/heads/gh-pages"
echo "done - Pages rebuilds in about a minute"
echo "https://iancao.github.io/settle/"
