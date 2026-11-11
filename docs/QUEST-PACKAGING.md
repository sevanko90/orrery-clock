# Packaging for Meta Quest (Horizon Store)

The app ships to the Quest as a **2D PWA package**: an Android app (APK) that opens
`https://sevanko90.github.io/orrery-clock/` in its own window, with the usual Enter VR and
tabletop buttons. It loads the live site, so app updates ship with every Pages deploy;
the package only needs rebuilding when the manifest (name, icons, start URL) changes.

Based on Meta's guides as of Nov 2026:
[PWA overview](https://developers.meta.com/horizon/documentation/web/pwa-overview-gs/),
[Package a PWA](https://developers.meta.com/horizon/documentation/web/pwa-packaging/),
[WebXR PWAs](https://developers.meta.com/horizon/documentation/web/pwa-webxr-gs/).
Check them again before a store submission.

## Status (paused 2026-11-11)

- Done: PWA icons and manifest `id` live; `sevanko90.github.io` root repo live with a `[]`
  `assetlinks.json` placeholder; signing folder created at `~/.android-signing/orrery-clock/`
  (empty: **no key exists yet**).
- First `bubblewrap init` on the Mac failed: the container is ARM (`aarch64`) and Bubblewrap only
  downloads an x86-64 JDK (it fetched an OpenJDK _source_ zip, so there was no `java`). The
  Android build tools Gradle uses (`aapt2`, `zipalign`) are x86-64 Linux only as well.
- So packaging now runs in a separate **`quest` compose service pinned to `linux/amd64`**
  (`docker compose run --rm -it quest …`). It runs natively on Windows/Linux x86 PCs and under
  Rosetta emulation on Apple silicon. Tested: image builds, `bubblewrap` runs, signing folder is
  writable. The broken JDK was cleared from the volume.
- **Open decision:** Apple is scaling Rosetta back after macOS 27, so emulation on the Mac is
  short-term. Options:

  | Option                                      | Key stays local? | Survives Rosetta? |
  | ------------------------------------------- | ---------------- | ----------------- |
  | `quest` service under Rosetta (works today) | yes              | no                |
  | `quest` service on a Windows/Linux x86 PC   | yes (on that PC) | yes               |
  | GitHub Actions builds, Mac signs            | yes              | yes               |
  | GitHub Actions builds and signs (secrets)   | no (GitHub)      | yes               |

  Leaning: CI builds an unsigned, aligned APK on an x86 runner; the Mac signs it with `apksigner`
  (Java, runs natively on ARM with an ARM JDK in the image). `bubblewrap init`/`fingerprint` can
  also run natively on ARM given an ARM JDK.

- Also open: PR #4 (store-sharing notes for this doc).

## What lives where

| What                                                    | Where                                                                 | Notes                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Bubblewrap CLI (`@meta-quest/bubblewrap-cli@1.24.1`)    | `quest` service image (x86-64 build of `.devcontainer/Dockerfile`)    | Pinned to the version Meta's guide was verified with.                                                        |
| JDK 17 + Android SDK                                    | named volume `orrery-clock-bubblewrap` → `/home/node/.bubblewrap`     | Downloaded by Bubblewrap on first run (~1 GB), kept across rebuilds.                                         |
| **Signing key** (`android.keystore`)                    | `SIGNING_DIR` in `.env` → `/home/node/signing` in the container       | On this Mac: `~/.android-signing/orrery-clock/`. Outside the repo, never committed.                          |
| Generated Android project (`twa-manifest.json`, Gradle) | `quest/` in this repo                                                 | Committed (Meta's guide has us edit `build.gradle`); build outputs are git-ignored.                          |
| Digital Asset Links (`assetlinks.json`)                 | repo `sevanko90/sevanko90.github.io` → `/.well-known/assetlinks.json` | Must be at the domain root, not under `/orrery-clock/`. Public: package name + certificate fingerprint only. |

### Back up the signing key

Back up **the `.keystore` file and both passwords** (key store password and key password)
together, somewhere other than this Mac: a password manager entry with the file attached, or an
encrypted backup. Every future update must be signed with the same key and use the same package
name. Lose either and the store app can never be updated; it would have to be republished as a
new app.

## Steps

All commands run in the x86-64 `quest` service (see Status). The interactive ones need a real
terminal (`-it`), so run them yourself, not through an agent: they ask for passwords.

1. **Build the packaging image** (first time only, after pulling this change):

   ```sh
   docker compose --profile quest build quest
   ```

2. **Make sure the live manifest is current**: the PWA icons/`id` change must be deployed,
   since `init` reads the manifest from the live site:
   `https://sevanko90.github.io/orrery-clock/manifest.webmanifest` should list PNG icons and an `id`.

3. **Create the Android project and the signing key** (interactive):

   ```sh
   docker compose run --rm -it quest \
     bubblewrap init --manifest=https://sevanko90.github.io/orrery-clock/manifest.webmanifest --metaquest
   ```

   On first run it offers to download the JDK and Android SDK: say yes (they go into the volume).
   Answers:
   - App mode: **2D**
   - Package ID: **`io.github.sevanko90.orreryclock`** (permanent: never change it)
   - Display mode: `standalone`; orientation: `landscape`
   - Horizon Billing: **no** (no in-app purchases)
   - Signing key: create a new one at **`/home/node/signing/android.keystore`**, alias `android`.
     Choose the passwords and put them straight into your password manager.

4. **Meta's Gradle edits** (in `quest/app/build.gradle`): set `targetSdk 32` with
   `//noinspection ExpiredTargetSdkVersion` on the line above (Quest runs API 32 or lower), and
   replace any `jcenter()` with `mavenCentral()`. Commit `quest/`.

5. **Digital Asset Links**: print the certificate fingerprint (asks for the store password):

   ```sh
   docker compose run --rm -it quest sh -c \
     '"$(dirname "$(find ~/.bubblewrap -path "*/bin/keytool" | head -1)")/keytool" -list -v -keystore ~/signing/android.keystore -alias android'
   ```

   Copy the `SHA256:` line, then:

   ```sh
   docker compose run --rm -it quest bubblewrap fingerprint add <SHA256 fingerprint>
   ```

   Copy the `assetlinks.json` it writes into the `sevanko90.github.io` repo at
   `.well-known/assetlinks.json` (replacing `[]`) and push. Check:
   `https://sevanko90.github.io/.well-known/assetlinks.json`.

6. **Build** (asks for both passwords):

   ```sh
   docker compose run --rm -it quest bubblewrap build
   ```

   Output: `quest/app-release-signed.apk` (git-ignored).

7. **Install on the headset**: the headset needs Developer Mode (Meta Horizon phone app →
   headset → Developer Mode). Docker on macOS can't reach USB devices, so either use Meta Quest
   Developer Hub on the Mac (drag the APK onto the device), or `adb` over Wi-Fi from the
   container if wireless debugging is set up. The app appears under Library → Unknown Sources.
   If it opens with a browser bar, the Digital Asset Links check failed: look for
   `TWA verification was unsuccessful!` in the device log.

8. **Store submission** (not covered yet): Meta developer account and organization, app created
   in the Developer Dashboard, store listing assets, privacy policy URL, data-use questionnaire,
   and the Virtual Reality Checks (VRCs). To be written up when we get there.
