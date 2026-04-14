#!/usr/bin/env bash
# Build Ghostly and upload the DMG to Cloudflare R2.
#
# Requires: awscli (brew install awscli), jq, bun, Rust toolchain.
# Credentials: copy .env.release.example to .env.release and fill in.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.release ]]; then
  echo "error: .env.release not found. Copy .env.release.example and fill it in." >&2
  exit 1
fi
set -a; source .env.release; set +a

: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"

VERSION=$(jq -r .version src-tauri/tauri.conf.json)
DMG_SRC="src-tauri/target/release/bundle/dmg/Ghostly_${VERSION}_aarch64.dmg"

echo "==> Building Ghostly ${VERSION}"
bun install
bun run tauri build

if [[ ! -f "$DMG_SRC" ]]; then
  echo "error: expected $DMG_SRC not found after build" >&2
  exit 1
fi

ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto

upload() {
  local key="$1"
  echo "==> Uploading s3://${R2_BUCKET}/${key}"
  aws s3 cp "$DMG_SRC" "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$ENDPOINT" \
    --content-type application/x-apple-diskimage \
    --cache-control "public, max-age=300"
}

upload "Ghostly-${VERSION}.dmg"
upload "Ghostly-latest.dmg"

cat <<EOF
==> Done.
Versioned: ${R2_PUBLIC_BASE:-<set R2_PUBLIC_BASE>}/Ghostly-${VERSION}.dmg
Latest:    ${R2_PUBLIC_BASE:-<set R2_PUBLIC_BASE>}/Ghostly-latest.dmg
EOF
