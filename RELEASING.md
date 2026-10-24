# Releasing Recordly

This repository uses `electron-builder` for macOS, Windows, and Linux packages. The Recordly-Keyviz-X fork currently keeps in-app auto-updates disabled and distributes releases manually, so an upstream build cannot replace fork-only features. `electron-builder.json5` points future update metadata at this fork; do not re-enable in-app updates until the fork feed is explicitly tested.

## What the release workflow does

When you publish a GitHub release tagged like `v1.2.3`, `.github/workflows/release.yml` will:

- validate that `package.json` is also `1.2.3`
- build macOS x64 and arm64 artifacts (requires signing secrets)
- notarize the macOS builds (requires Apple credentials)
- merge the dual-architecture `latest-mac.yml` metadata into one release asset
- build the Windows NSIS installer; it is signed only when Windows signing secrets are configured
- build the Linux AppImage
- publish installer artifacts and update metadata files to the GitHub release (the fork app currently keeps in-app updates disabled)
- dispatch the Homebrew tap workflow after the release assets are available

The release includes platform update metadata for future use. This fork currently disables in-app update checks and relies on manual downloads from its GitHub Releases page.

## Required GitHub secrets

### macOS signing and notarization

Set these repository secrets:

- `APPLE_SIGNING_CERTIFICATE_P12_BASE64`
- `APPLE_SIGNING_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`APPLE_SIGNING_CERTIFICATE_P12_BASE64` must be a base64-encoded `.p12` export of a `Developer ID Application` certificate.

If the certificate you currently have is only `Apple Development`, that is not enough for public notarized releases and auto-update distribution. You need `Developer ID Application`.

To export and encode the certificate:

```
security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -P "YOUR_P12_PASSWORD" -o recordly-mac-signing.p12
base64 < recordly-mac-signing.p12 | pbcopy
```

Paste the copied base64 into `APPLE_SIGNING_CERTIFICATE_P12_BASE64` and the export password into `APPLE_SIGNING_CERTIFICATE_PASSWORD`.

### Windows signing

Set these repository secrets:

- `WINDOWS_SIGNING_CERTIFICATE_P12_BASE64`
- `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`

These should point to an Authenticode code-signing certificate exported as `.p12` and then base64-encoded. They are optional in CI; when absent, the Windows installer is unsigned and may trigger SmartScreen warnings.

### Homebrew tap automation

Set this repository secret if you want the cask PR to open automatically:

- `HOMEBREW_TAP_TOKEN`

Optional repository variables:

- `HOMEBREW_TAP_REPO`
- `HOMEBREW_TAP_AUTO_MERGE`

## Release flow

1. Bump `package.json` to the version you want to ship.
2. Commit and push that version.
3. Create a Git tag whose version exactly matches `package.json` after the leading `v` (for example `v1.4.0-fork.3` ↔ `1.4.0-fork.3`).
4. Create and publish a GitHub release for that tag. Fork releases must target `nguyendinhquocx/Recordly-Keyviz-X`; the helper defaults to `origin` rather than the upstream `package.json.repository`. Prefer the helper so custom notes are prepended while GitHub still generates the contributor section:

```
npm run release:create -- --repo nguyendinhquocx/Recordly-Keyviz-X --tag v1.2.3 --title "v1.2.3" --notes-file ./release-notes.md
```

For Windows/Linux-only prereleases, set the GitHub release as prerelease and include `<!-- release-scope: windows-linux -->` in the custom notes; this skips macOS signing jobs. Stable releases currently require all platform jobs and configured Apple signing/notarization secrets.

For prereleases:

```
npm run release:create -- --repo nguyendinhquocx/Recordly-Keyviz-X --tag v1.2.0-beta.2 --title "v1.2.0 beta-2" --prerelease --notes-file ./release-notes.md
```

This uses `gh release create --generate-notes`, which keeps GitHub's generated change summary and contributor list instead of replacing it with a fully manual release body.

5. The `Publish Release` workflow builds, signs, notarizes, uploads, and publishes update metadata.

That is the normal path if you want “click new release and let CI do the rest.”

## Rebuilding an existing release

If you need to rerun publishing for an existing tag, use the manual dispatch for `.github/workflows/release.yml` and provide the existing tag.

### Windows: Keyviz overlay sidecar

The Windows package bundles the [Keyviz](https://github.com/mulaRahul/keyviz) keyboard overlay as a sidecar, and includes its GPLv3 license at `resources/keyviz/LICENSE`, the vendored `rdev` MIT license at `resources/keyviz/rdev-LICENSE`, plus `resources/THIRD_PARTY_NOTICES.md`. Build it before `build:win`:

```
npm run build:keyviz-sidecar
```

This installs Keyviz frontend deps with pnpm (`pnpm install --frozen-lockfile` inside `keyviz/`), builds the Tauri/Rust app in sidecar mode (`--config src-tauri/tauri.sidecar.conf.json`, with an identity distinct from standalone Keyviz), and stages `recordly-keyviz.exe`. `electron-builder` picks it up from `keyviz/src-tauri/target/release/sidecar/` via `extraResources`; `npm run smoke:packaged-binaries` verifies it is present in packaged output. Requires the Rust toolchain and pnpm on top of the Windows prerequisites above. The sidecar speaks a line-delimited JSON protocol over stdio (no TCP), only installs its input hook after Recordly explicitly requests capture, and exits when its stdin closes. If standalone Keyviz is already running, Recordly reports the conflict and does not start a second overlay or kill the standalone process.

A clean local Windows package build runs `npm run build:win`; its `prebuild:win` hook builds the sidecar first. The GitHub `build.yml` and `release.yml` Windows jobs set up pnpm and Rust and run the same sidecar build before `electron-builder`. To verify the integration from the repository root:

```
npm run typecheck
npm run i18n:check
npm test -- electron/ipc/keyvizSidecar.test.ts electron/ipc/globalShortcuts.test.ts
npm run build:win
npm run smoke:packaged-binaries
```

## Notes

- If the fork later enables in-app updates, macOS requires the `zip` target in addition to `dmg`, because `latest-mac.yml` is generated from the zipped build.
- macOS arm64 and x64 builds both publish updater zips, and the release workflow merges them into one `latest-mac.yml` so `electron-updater` can choose the correct architecture automatically.
- The release workflow publishes versioned artifact names so the generated update metadata matches the uploaded files.
- `build.yml` is intentionally forced to `--publish never` so ad hoc CI builds do not accidentally upload to a draft release.
