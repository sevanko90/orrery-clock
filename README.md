# orrery-clock

A mechanical 3D orrery and clock in the browser: walnut, brass and a working gear train, with the planets at their true positions for any date. Static site — Vite + TypeScript + three.js, no backend. See [docs/SPEC.md](docs/SPEC.md).

## Commands (run inside the container)

```bash
docker compose exec app npm test          # astronomy unit tests
docker compose exec app npm run build     # production build to dist/
docker compose exec app npm run textures  # re-fetch planet textures from Wikimedia Commons
docker compose exec app npm run design    # re-solve gear trains + layout into src/mechanism/design.json
```

Textures are generated once by `npm run textures` and committed under `public/textures/`; the deployed site serves them itself and never contacts Wikimedia at runtime. Attribution: Solar System Scope (CC BY 4.0) and NASA, via Wikimedia Commons — shown in the page footer and Credits dialog.

## Deploy

Push to `main` on GitHub with Pages set to "GitHub Actions" as the source; `.github/workflows/deploy.yml` tests, builds and publishes.

## Development Environment

The dev environment runs inside Docker, so you need no local Node.js install. There are two ways to start it, and both use the same `docker-compose.yml`, so the environment is identical either way:

| Method                    | Best for                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **VS Code Dev Container** | Full IDE integration — extensions, settings, and the terminal all run inside the container |
| **`docker compose up`**   | Any editor, or headless / CI use                                                           |

### Option 1 — VS Code Dev Container

1. Install the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension.
2. Open this folder in VS Code.
3. Click **Reopen in Container** when prompted.

### Option 2 — `docker compose up`

```bash
docker compose up
```

## First run: this is environment-only

This scaffold sets up the container, not the app. On first `docker compose up` there's no `package.json` yet, so the container will print instructions and idle. Open a shell in it and scaffold your app:

```bash
docker compose exec app sh
npm install   # app is already scaffolded
```

Then restart with `docker compose up` — it will detect `package.json`, run `npm install`, and start the dev server.

## Port

The dev server listens on port **`${DEV_PORT:-5173}`**. Override it in a `.env` file at the project root (copy `.env.example` to start).

## How the Docker setup works

- **`docker-compose.yml` is the source of truth.** All setup (permissions, install, run) happens in its `command:`, so the devcontainer just points at it — there's no separate `postCreateCommand` to keep in sync.
- **`node_modules` is a named volume**, not part of the bind mount (`.:/workspace`). This keeps native/platform-specific binaries out of your host OS, avoids the very slow Windows/WSL2 bind-mount performance hit for `node_modules`, and persists installed packages across container rebuilds.
- **First-run permission fix**: new Docker volumes are owned by `root`. The startup command detects this via a sentinel file (`.volume_initialized`) and `chown`s it to the `node` user once.
- **`user: node`**: the base image (`mcr.microsoft.com/devcontainers/typescript-node:26`) is designed to run as this non-root user.
