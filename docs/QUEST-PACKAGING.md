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

## What lives where

| What                                                    | Where                                                                 | Notes                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Bubblewrap CLI (`@meta-quest/bubblewrap-cli@1.24.1`)    | dev image (`.devcontainer/Dockerfile`)                                | Pinned to the version Meta's guide was verified with.                                                        |
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

All commands run in the dev container. The interactive ones need a real terminal (`-it`), so
run them yourself, not through an agent: they ask for passwords.

1. **Rebuild the dev container** (first time only, after pulling this change):

   ```sh
   docker compose up -d --build
   ```

2. **Make sure the live manifest is current**: the PWA icons/`id` change must be deployed,
   since `init` reads the manifest from the live site:
   `https://sevanko90.github.io/orrery-clock/manifest.webmanifest` should list PNG icons and an `id`.

3. **Create the Android project and the signing key** (interactive):

   ```sh
   docker compose exec -it -w /workspace/quest app \
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
   docker compose exec -it app sh -c \
     '"$(dirname "$(find ~/.bubblewrap -path "*/bin/keytool" | head -1)")/keytool" -list -v -keystore ~/signing/android.keystore -alias android'
   ```

   Copy the `SHA256:` line, then:

   ```sh
   docker compose exec -it -w /workspace/quest app bubblewrap fingerprint add <SHA256 fingerprint>
   ```

   Copy the `assetlinks.json` it writes into the `sevanko90.github.io` repo at
   `.well-known/assetlinks.json` (replacing `[]`) and push. Check:
   `https://sevanko90.github.io/.well-known/assetlinks.json`.

6. **Build** (asks for both passwords):

   ```sh
   docker compose exec -it -w /workspace/quest app bubblewrap build
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

## After store approval

- **Sharing** (`src/ui/share.ts`): the share button keeps sharing the website. Inside the
  packaged app the page is the live site, so it already does, and the website works for whoever
  receives the link (phone, desktop, or VR in Quest Browser). Once the store page exists
  (`meta.com/experiences/<id>`, assigned at submission), _add_ to it rather than replace it:
  - a "Get it on Meta Quest" link in the share menu and the credits corner, pointing at the
    store page;
  - optionally a share text that mentions both, e.g. "…in your browser, or on Meta Quest:
    <store link>";
  - consider showing the store link only to Quest Browser visitors and hiding it inside the
    packaged app itself (Meta's suggested check for the packaged app:
    `window.getDigitalGoodsService !== undefined`).
