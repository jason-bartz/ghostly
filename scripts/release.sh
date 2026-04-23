#!/usr/bin/env bash
# Cut a new Ghostly release.
#
# Usage: ./scripts/release.sh <version>   e.g. ./scripts/release.sh 0.1.3
#
# Bumps version in tauri.conf.json / Cargo.toml / package.json, refreshes
# Cargo.lock, commits + pushes to main, and triggers the GitHub Release
# workflow. The workflow builds, signs, notarizes, and uploads the DMG to
# both GitHub Releases (as a draft) and Cloudflare R2. Publish the draft
# manually once you've smoke-tested the build.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   e.g. $0 0.1.3" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be semver X.Y.Z (got '$VERSION')" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree not clean — commit or stash first" >&2
  exit 1
fi

NOTES_FILE="release-notes/v${VERSION}.md"
if [[ ! -f "$NOTES_FILE" ]]; then
  echo "error: $NOTES_FILE not found" >&2
  echo "       write the release notes first:" >&2
  echo "       mkdir -p release-notes && \$EDITOR $NOTES_FILE" >&2
  exit 1
fi
if [[ ! -s "$NOTES_FILE" ]]; then
  echo "error: $NOTES_FILE is empty" >&2
  exit 1
fi

CURRENT=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)
echo "==> Bumping $CURRENT -> $VERSION"

sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
sed -i '' "s/^version = \"$CURRENT\"$/version = \"$VERSION\"/" src-tauri/Cargo.toml
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$VERSION\"/" package.json

echo "==> Refreshing Cargo.lock"
(cd src-tauri && cargo check --quiet)

echo "==> Committing + pushing"
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json "$NOTES_FILE"
git commit -m "chore: bump version to $VERSION"
git push origin main

echo "==> Triggering release workflow"
gh workflow run release.yml --ref main --repo jason-bartz/ghostly

sleep 3
RUN_ID=$(gh run list --workflow=release.yml -L 1 --repo jason-bartz/ghostly --json databaseId -q '.[0].databaseId')

cat <<EOF

==> Release triggered.
Run:      https://github.com/jason-bartz/ghostly/actions/runs/$RUN_ID
Watch:    gh run watch $RUN_ID --repo jason-bartz/ghostly
Publish:  gh release edit v$VERSION --repo jason-bartz/ghostly --draft=false

Takes ~10 min. Once successful:
  - v$VERSION draft on GitHub with signed/notarized DMG
  - https://downloads.try-ghostly.com/Ghostly-latest.dmg auto-updated
EOF
