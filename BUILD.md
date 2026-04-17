# Build Instructions

Ghostly is a macOS-only application. This guide covers setting up the development environment and building from source.

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- [Tauri Prerequisites](https://tauri.app/start/prerequisites/)
- Xcode Command Line Tools: `xcode-select --install`

macOS 10.15 (Catalina) or later. Apple Silicon or Intel.

## Setup

### 1. Clone

```bash
git clone git@github.com:jason-bartz/ghostly.git
cd ghostly
```

### 2. Install dependencies

```bash
bun install
```

### 3. Download the VAD model

```bash
mkdir -p src-tauri/resources/models
curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx
```

### 4. Run in dev mode

```bash
bun tauri dev
```

If you hit a cmake policy error:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

### 5. Build for production

```bash
bun run tauri build
```

Produces a signed `.dmg` and `.app` bundle under `src-tauri/target/release/bundle/`.

## Updater Setup (one-time)

Ghostly ships with the Tauri updater plugin. Before cutting the first release on a new clone you must generate a dedicated **updater signing keypair** (this is separate from the license-verification key that lives in `src-tauri/src/license.rs` — do not reuse it).

### 1. Generate the keypair

```bash
# Writes minisign-format keys to the given path. Keep the password in a
# password manager; it unlocks the private key in CI.
bun tauri signer generate -w ~/.ghostly/updater.key
```

The command prints the **public key** (a single-line base64 string). Copy that string into `src-tauri/tauri.conf.json`, replacing the `REPLACE_WITH_UPDATER_PUBKEY` placeholder:

```json
"updater": {
  "active": true,
  "endpoints": ["https://downloads.try-ghostly.com/updates.json"],
  "pubkey": "<PASTE PUBLIC KEY HERE>"
}
```

> Dev builds (`bun tauri dev`) work with the placeholder — the updater check fails silently. But `bun run tauri build` with the signing env vars set will fail validation unless the pubkey is a real minisign public key that matches the private key.

### 2. Store the private key as a GitHub secret

Two secrets must exist on the repository (or org):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.ghostly/updater.key` (the encrypted private key file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you set during `tauri signer generate` |

These are referenced by `.github/workflows/build.yml` and consumed by `tauri-action`, which uses them to sign the `.app.tar.gz` bundle and emit the matching `.sig` file.

> **Back up the private key and password offline.** If either is lost, all existing installs will be stranded — they can no longer verify updates signed by a new key without a manual reinstall.

### 3. Point the update endpoint at R2

The release workflow publishes three objects to the R2 bucket on every release:

- `releases/v<version>/Ghostly-darwin-aarch64.app.tar.gz` (immutable, long-cache)
- `Ghostly-darwin-aarch64.app.tar.gz` (latest alias, short-cache)
- `updates.json` (manifest, 60s cache)

`updates.json` is served at `https://downloads.try-ghostly.com/updates.json`. That hostname is a CNAME to the R2 bucket; configure it in Cloudflare if it does not already exist. The manifest URL is baked into the app config, so changing it requires a rebuild.

### 4. Verify end-to-end

1. Bump the version in `src-tauri/tauri.conf.json` (and `package.json`).
2. Run the **Release** workflow from GitHub Actions.
3. Download and install the resulting DMG on a clean machine.
4. Bump the version again, run Release again.
5. Launch the older install — within ~3 seconds of reaching the main UI the footer should show **Update available** and the modal should open showing release notes.

## Releasing

```
bun run tauri build
```
…is the local path; for production releases, trigger `.github/workflows/release.yml` from GitHub. The workflow:

1. Creates a draft GitHub Release named `v<version>`.
2. Builds + signs the `.app`, `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig`.
3. Uploads the DMG to R2 as `Ghostly-latest.dmg`.
4. Uploads the `.app.tar.gz` to R2 under `releases/v<version>/` and as the `latest` alias.
5. Writes `updates.json` with version, release notes, pub_date, and the Ed25519 signature, and uploads it to R2.
6. Syncs the displayed version on try-ghostly.com.

Edit the draft release on GitHub to publish once you've smoke-tested the build.
