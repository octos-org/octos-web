# octos-web

The web app for [octos](https://github.com/octos-org/octos). Chat with your agent, talk to it by voice or video, build slide decks and sites with it, and administer the whole server — from a browser.

## Just want to use it?

**You don't need this repo.** A production build of the web app ships inside the octos server itself:

```bash
brew install octos-org/tap/octos    # or: npm install -g @octos-org/octos
octos init                          # pick an AI provider, paste its API key
octos serve --solo                  # password-free local sign-in
```

Then open **http://localhost:50080/app/** and click the local sign-in button. (Installed octos as a background service via its install script? The app is at `http://localhost:8080/app/`.) Full walkthrough: the [octos Start here guide](https://github.com/octos-org/octos#start-here).

This repo is for **developing or customizing the client**. octos-web is one of two first-party clients for the octos server; the other is [octos-tui](https://github.com/octos-org/octos-tui) for the terminal.

## Octos Cloud

Don't want to run anything yourself? **Octos Cloud** is the hosted, multi-tenant way in — and the account experience (signup, email-code sign-in, your tenant's dashboard) is delivered by this web client:

1. Go to [octos.cloud](https://octos.cloud) (or your self-hosted operator's portal).
2. Register with your email.
3. Choose a custom node name.
4. Run the generated setup command on your device.

That setup command is personalized for your machine and includes the values needed to connect your device to the Octos cloud relay. After setup, your Octos instance is accessible on the public internet under your node name.

Two credentials come out of signup, and it pays to know which is which:

- **Signing in to the app** (`https://<your-name>.octos.cloud/app/`) uses your **email code** — same as the login page anywhere else.
- **The admin dashboard** (`https://<your-name>.octos.cloud/admin/`) accepts the **`--auth-token` value from your setup command**: pick the *"Login with admin token"* tab on its login screen and paste it. The same command was emailed to you at signup, so the token is always recoverable from that email (or from the service file the installer wrote on your device).

When you click `Send Code` on the portal, check your Spam folder if the email does not arrive right away. It is also a good idea to add the Octos sending domain/address to your address book so future login and setup emails are delivered reliably.

After signup, the portal shows your node details, public URL, and the setup command to run on your device:

<img src="images/octos-cloud-signup.png" alt="Octos Cloud signup response" width="50%" />

Octos Cloud is the best choice if you want:

- the fastest time to first working system
- public access without running your own VPS
- a hosted signup and tunnel flow

Multi-tenant accounts, per-user isolation, and the admin surfaces for them are web-client territory; the terminal client stays single-user. **Operators**: the server-side infrastructure behind this — the portal host, relay, and wildcard TLS — is deployed from the octos repo; see [self-hosted cloud + tenant pair](#option-3-self-hosted-cloud--tenant-pair).

## Self-hosting & deployment

Run your own Octos **server** — on one machine, or as a public cloud + tenant
pair. (To develop or customize the web *client* in this repo instead, jump to
[Develop the client](#develop-the-client).)

### Choose a setup path

If you just want an assistant on your own machine, you already have it — the [Start here](https://github.com/octos-org/octos#start-here) steps in the octos repo are Option 2 in its simplest form. The paths below matter when you want a managed signup, a background service, or public internet access.

| Option | Machines involved | Public internet access | Who manages the infrastructure | Best fit |
| --- | --- | --- | --- | --- |
| **1. Octos Cloud signup** | Your device + Octos Cloud | Yes | Octos Cloud + you | Hosted accounts — [see above](#octos-cloud) |
| **2. Self-hosted local-only** | One machine | No | You | Local/private use |
| **3. Self-hosted cloud + tenant pair** | Your VPS + your device | Yes | You | Full self-hosting with remote access |

Visual overview:

<img src="https://raw.githubusercontent.com/octos-org/octos/main/images/octos-options.jpg" alt="Three ways to run Octos: Octos Cloud signup, self-hosted local-only, and self-hosted cloud plus tenant pair" width="100%" />

### Option 1: Sign up on Octos Cloud

Octos Cloud is the hosted, multi-tenant way in: register with your email at
[octos.cloud](https://octos.cloud) (or a self-hosted operator's portal), pick a
node name, and run one generated setup command on your device. The signup and account experience is part of the **web client** —
the walkthrough is in the [Octos Cloud](#octos-cloud) section above.

The **server infrastructure** an operator runs to offer it is below: see [Option 3](#option-3-self-hosted-cloud--tenant-pair)
for deploying the cloud host (portal, relay, wildcard TLS) yourself.

### Option 2: Self-hosted local-only

Choose this if you want Octos on your own machine with no public exposure. Your dashboard is available only on the machine itself or your local network.

```bash
# macOS / Linux
curl -fsSL https://github.com/octos-org/octos/releases/latest/download/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://github.com/octos-org/octos/releases/latest/download/install.ps1 | iex
```

This installs the binary, sets up `octos serve` as a service, and starts the local dashboard at `http://localhost:8080/admin/`. The end-user web app is served same-origin at `http://localhost:8080/app/` (embedded in the binary — no separate web server needed).

**First login to the dashboard.** The install summary prints your credential once:

```text
Auth token: 3f2a…64-hex…c9d1
```

Open `http://localhost:8080/admin/`, switch the login screen to the
**"Login with admin token"** tab, and paste that token — you're in as the
admin user. (The email-code tab needs the server's SMTP configured, so the
token tab is the way in on a fresh local install.)

Lost the token? It's kept in the service definition the installer wrote:

```bash
# macOS
grep -A1 OCTOS_AUTH_TOKEN /Library/LaunchDaemons/io.octos.serve.plist
# Linux
grep OCTOS_AUTH_TOKEN /etc/systemd/system/octos-serve.service
```

Alternatively, install just the binaries (the `octos` server plus its bundled skills) via a package manager:

```bash
# Homebrew (macOS Apple Silicon, Linux x86_64/ARM64) — this repo is its own tap
brew tap octos-org/octos https://github.com/octos-org/octos
brew install octos-org/octos/octos

# npm (macOS Apple Silicon, Linux x86_64/ARM64, Windows x64)
npm install -g @octos-org/octos
```

Both install the full release bundle — the `octos` server (with the web app and dashboard embedded) and its bundled skills (`news_fetch`, `deep-search`, `deep_crawl`, `send_email`, `account_manager`, `clock`, `weather`, plus the `voice` platform-skill) kept side-by-side so `octos serve` discovers them at startup. Unlike `install.sh`, they do not set up a background service; run `octos serve` yourself.

Supported platforms: **macOS ARM64**, **Linux x86_64**, **Linux ARM64**, and **Windows x64**.

Choose this path if you want:

- the simplest self-hosted setup
- one machine only
- local-network access only
- the option to upgrade later to tenant mode

### Option 3: Self-hosted cloud + tenant pair

Choose this if you want full self-hosting but still want your own device accessible from anywhere on the public internet.

This mode uses two machines:

- a **cloud VPS** that runs the public relay and HTTPS entrypoint
- your **tenant device** that runs your own Octos instance

The tenant device connects outbound to the VPS using `frpc`. The VPS runs the public components, including TLS and routing. This gives you ngrok-style public access, but through your own infrastructure.

For production use, the VPS also needs wildcard HTTPS. The current setup uses Caddy plus Cloudflare DNS challenge, or another supported DNS provider, to issue and manage certificates for the main domain and tenant subdomains.

Requirements for this option:

1. **Your own hosted domain name**
   Example: `octos.example.com`
2. **A DNS provider / authoritative DNS API**
   Its role here is specifically the ACME `DNS-01` solver used by Caddy's internal ACME client to mint the wildcard certificate for `*.octos.example.com`, which is what tenant subdomains use. If you stay HTTP-only with `--http-only`, or if you only need the apex domain, this wildcard-DNS flow is not required.
3. **An SMTP service**
   This is needed so the cloud host can send OTP emails to tenants during portal signup and login.

#### 1. Bootstrap the VPS

On a Linux VPS with DNS already pointed at it, you can either:

- run the script with full flags for a mostly non-interactive flow, or
- run `bash scripts/cloud-host-deploy.sh` with no flags and let it prompt you interactively

Before running it, export the environment variables needed by your chosen providers. For example:

```bash
export CF_API_TOKEN=xxx
export SMTP_PASSWORD=xxx
```

Notes:

- For Cloudflare, the script expects `CF_API_TOKEN` for the DNS provider token.
- For SMTP, you can pre-export `SMTP_PASSWORD` so the bootstrap does not need that secret entered later.
- If you enable SMTP, the script will also prompt for or use the rest of the SMTP settings such as host, port, username, and from-address.

Example using explicit flags:

```bash
git clone https://github.com/octos-org/octos.git
cd octos
bash scripts/cloud-host-deploy.sh \
    --domain octos.example.com \
    --https --dns-provider cloudflare
```

Interactive mode:

```bash
git clone https://github.com/octos-org/octos.git
cd octos
bash scripts/cloud-host-deploy.sh
```

This wraps three host-side steps:

- `scripts/install.sh` — installs `octos serve` and sets `mode = "cloud"`
- `scripts/frp/setup-frps.sh` — installs and configures `frps`
- `scripts/frp/setup-caddy.sh` — configures public routing and wildcard HTTPS

Windows Server targets use the PowerShell deploy script from an operator machine
with OpenSSH access to the server:

```powershell
.\scripts\deploy.ps1 `
    -HostName win.example.com `
    -User Administrator `
    -Version latest `
    -RemoteRoot 'C:\octos' `
    -ServiceName OctosServe
```

Run the same command with `-DryRun` first to print the remote commands without
connecting. The script deploys the `octos-bundle-x86_64-pc-windows-msvc.zip`
release bundle, installs `octos.exe` under `C:\octos\bin`, stores runtime data in
`C:\octos\data`, writes logs under `C:\octos\logs`, and registers `OctosServe` as
an auto-start Windows service through NSSM. Use `-LocalBundle <zip>` to deploy a
locally built bundle over `scp`, and `-Uninstall [-Purge]` to remove the service
and optionally delete the remote install root.

Recommended DNS split:

- `octos.example.com` and `*.octos.example.com` for the portal and tenant dashboards
- `frps.octos.example.com` as `DNS only` so tenant machines can reach the FRP control port

#### 2. Register or create a tenant

Once the VPS is up, the cloud host can issue a personalized tenant setup command. That command includes the tenant name, per-tenant tunnel token, SSH port, dashboard auth token, domain, and relay address. The user receives this command directly in the portal and also by email.

#### 3. Run the tenant setup command on your own device

Use the exact command provided in step 2. The example below is reference only, to show what kind of command the portal issues:

```bash
curl -fsSL https://github.com/octos-org/octos/releases/latest/download/install.sh | bash -s -- \
    --tunnel \
    --tenant-name alice \
    --frps-token <per-tenant-uuid> \
    --ssh-port 6001 \
    --domain octos.example.com \
    --frps-server frps.octos.example.com \
    --auth-token <dashboard-token>
```

The installer writes the tenant tunnel configuration, installs `frpc`, and starts the public tunnel alongside `octos serve`. The `--auth-token` in your personalized command doubles as your dashboard login: open `https://<your-name>.<domain>/admin/` and paste it into the **"Login with admin token"** tab (the same command also arrives by email, so the token is recoverable there).

### Can I start local and upgrade later?

Yes.

A local-only self-hosted machine can be upgraded later to tenant mode once you have a cloud host available. The saved installers support this directly:

```bash
# macOS / Linux
~/.octos/bin/install.sh --tunnel
~/.octos/bin/install.sh --doctor
```

```powershell
# Windows
& "$HOME\.octos\bin\install.ps1" -Tunnel
& "$HOME\.octos\bin\install.ps1" -Doctor
```

That upgrade path is intentional: start with one machine, then add a VPS only when you need internet-facing access.

### Optional self-hosted features

```bash
# Auto-install runtime dependencies (git, node, python, ffmpeg, chromium)
curl ... | bash -s -- --install-deps

# Set up Caddy reverse proxy with HTTPS for self-hosted local deployments
curl ... | bash -s -- --caddy-domain crew.example.com
```

### Uninstall

Use the matching uninstall flag on the machine you want to remove:

```bash
# Tenant or local machine (macOS / Linux)
~/.octos/bin/install.sh --uninstall

# Tenant or local machine (Windows PowerShell)
& "$HOME\.octos\bin\install.ps1" -Uninstall

# Cloud VPS — removes octos serve, frps, and Caddy
bash scripts/cloud-host-deploy.sh --uninstall

# Cloud VPS + wipe data directory (~/.octos) as well
bash scripts/cloud-host-deploy.sh --uninstall --purge
```

### Where config lives

User config + credentials live **outside** the install dir so reinstalls/upgrades never touch them:

- **macOS + Linux:** `~/.config/octos/` (`config.json`, `auth.json`) — honours `$XDG_CONFIG_HOME`
- **Windows:** `%APPDATA%\octos\`
- **Override:** set `OCTOS_CONFIG_DIR` to put config/auth anywhere
- `~/.octos/` holds only the **install + runtime state** (binaries, bundled skills, sessions, logs). The installer writes only there.

An existing `~/.octos/config.json` from older versions is auto-migrated to `~/.config/octos/` on first run (copied, not moved — the original stays as a backup).

### Runtime deployment modes

Octos uses `"mode"` in `config.json` (see *Where config lives* above) to describe how a running node behaves:

- **`local`** — standalone machine
- **`tenant`** — end-user machine with an optional public tunnel
- **`cloud`** — VPS relay with tenant management and public signup

`scripts/install.sh` and `scripts/install.ps1` create local or tenant configs. `scripts/cloud-host-deploy.sh` creates or updates cloud-host configs with `mode = "cloud"` plus `tunnel_domain` and `frps_server`.

## Surfaces

| Route | What it is |
|---|---|
| `/` | Project launcher — every chat, deck, and site as a project card |
| `/home` | Home-assistant standby — clock, weather/news/calendar/photo/smart-home widgets, night mode, wake-word |
| `/voice` | Voice assistant — on-device VAD, streamed TTS with barge-in, spoken transcripts, user-selectable voices, live video chat |
| `/chat` | The chat workbench — streaming turns, tool activity, approvals and clarifying-question cards, a context-compaction indicator with a manual `/compact` command, file uploads, rich media |
| `/studio/:projectId` | Studio — three-pane grounded workspace (sources · chat · skills) pinned to a project session |
| `/slides`, `/slides/:id/present` | Slide-deck gallery, editor, and full-screen present mode |
| `/sites`, `/sites/:id` | Generated-site gallery and editor with signed previews |
| `/settings` | Admin dashboard — LLM providers & failover, users, profiles, channels, sandbox, tools, system metrics & live logs, server watchdog, skills hub, voice, Ominix home, appearance |
| `/login` | Email-code login, or password-free solo login against `octos serve --solo` |

## Develop the client

Prereqs: Node 20.19+ (Vite 7's floor), and an octos server (install above). The client is a React SPA talking to the server over UI Protocol v1 (see [How it connects](#how-it-connects)).

**Stack:** React 19 · TypeScript · Vite 7 · Tailwind CSS 4 · react-router 7 · Vitest + Playwright.

```bash
# 1. Run the backend on :50080 (from anywhere)
octos serve --solo          # --solo = password-free local login; plain `octos serve` needs email-code (SMTP)

# 2. Run the web client in dev mode
npm ci
npm run dev                 # Vite dev server on http://localhost:5173
```

The dev server proxies `/api` (including the WebSocket upgrade) to `http://localhost:50080`, so the app is same-origin out of the box. Sign in with one click on the solo button (email-code login needs the server's SMTP configured).

### If something looks wrong

| Symptom | Fix |
|---|---|
| Blank app / WebSocket won't connect | Is the server running on **:50080**? (A service install listens on :8080 — point the proxy or your browser at the right one.) |
| Login code never arrives | The local server has no SMTP — run `octos serve --solo` and use the solo button instead. |
| `npm ci` or `npm run dev` fails | Check `node --version` — Vite 7 needs Node 20.19+. |

## Build, lint, test

`predev`/`prebuild` copy the VAD/onnx wasm assets (`scripts/copy-vad-assets.mjs`) automatically.

```bash
npm run build          # tsc -b && vite build  → dist/
npm run preview        # serve the production build locally
npm run lint           # eslint

npm run test:unit      # Vitest unit suite (~750 tests across 80+ files, jsdom, no server needed)
npm test               # Playwright e2e — needs the app + a LIVE octos server
npm run test:live:smoke   # fast live smoke subset
npm run test:live:long    # long-running live scenarios (deep research, TTS)
```

The unit suite is the merge gate. Playwright specs (in `tests/`) drive a real browser and exercise live server behavior — run them when touching transport, voice, or session flows. Their default `baseURL` is `http://localhost:5174` (override with `BASE_URL`); the Vite dev server listens on `:5173`, so point the specs at your dev server with `BASE_URL=http://localhost:5173` or serve a build on `:5174`.

## How it connects

- **Transport** — `src/runtime/ui-protocol-bridge.ts`: a strict, fail-closed JSON-RPC bridge over WebSocket at `/api/ui-protocol/ws`. Reconnects with exponential backoff, resumes with an `after` cursor + `session/hydrate`, and queues outbound RPCs while offline. This is the *only* chat transport (the legacy SSE/REST bridge is gone).
- **Events → state** — when `session/open` confirms `projection.envelope.v2`, flattened canonical envelopes flow directly through `src/store/projection-store.ts` and its read-only render adapter. Older servers continue to use the retained `src/store/thread-store.ts` notification path; the two render models are never combined.
- **Auth** — session token (`octos_session_token`) and optional admin token (`octos_auth_token`) in localStorage; the WS handshake carries the token as a query parameter.

The protocol contract lives in the octos repo (`crates/octos-core/src/ui_protocol.rs` and the API docs). Server merges do not wait for client releases — the spec is the contract.

## Configuration

| Env var | Purpose |
|---|---|
| `BASE_URL` | Vite base path for subpath deploys (e.g. `/octos-web/`) |
| `VITE_SKIP_AUTH` | Build-time: skip the auth guard — static/demo builds only |
| `VITE_WEBHOOK_ORIGIN` / `VITE_PUBLIC_API_ORIGIN` | Origin used when displaying channel webhook URLs in settings (fallback order) |
| `VITE_SMART_HOME_API_BASE` | Smart-home widget backend (dev proxy: `/smart-home-api` → `:8787`) |

API and WebSocket traffic is always **same-origin** (`/api/...`) — serve the
bundle behind the same host as `octos serve` (or a reverse proxy to it);
there is no env var that repoints the API.

## Deploying

- **Static canary** — `.github/workflows/deploy.yml` publishes the app to GitHub Pages (`BASE_URL=/octos-web/`, SPA `404.html` fallback), plus the `book/` mdBook of sample research reports under `/book`. The workflow does not set `VITE_SKIP_AUTH`, so the Pages build still shows the login screen; export it yourself for an auth-free demo build.
- **Production** — build with `npm run build` and serve `dist/` from any static host or reverse proxy in front of `octos serve` (see [Self-hosting & deployment](#self-hosting--deployment) for the server/fleet setup). The app is a pure static bundle; all state lives in the server.

## Repository layout

```
src/
  runtime/     UI Protocol bridge, event router, runtime provider
  store/       thread-store, projection, voice/task/file/content/project stores
  components/  chat workbench, thread, composer, media
  home/        home-assistant surface, widget registry, voice assistant
  studio/      three-pane studio workspace
  settings/    admin dashboard tabs
  slides/  sites/  pages/  remaining surface modules
tests/         Playwright e2e specs
book/          mdBook sample reports (published to /book)
```

## License

MIT — see [LICENSE](LICENSE).
