# YT Clear View (YTCV)

---

<p align="center">
  <a href="https://github.com/GOTXE/yt-clear-view/releases/tag/v0.13.0"><img src="https://img.shields.io/badge/release-v0.13.0-005AA4?style=for-the-badge" alt="Release"></a>
  <a href="#usage"><img src="https://img.shields.io/badge/runtime-docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2E7D32?style=for-the-badge" alt="License"></a>
</p>
<p align="center">
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python"></a>
  <a href="https://flask.palletsprojects.com/"><img src="https://img.shields.io/badge/flask-3.x-000000?style=for-the-badge&logo=flask&logoColor=white" alt="Flask"></a>
  <a href="https://www.sqlalchemy.org/"><img src="https://img.shields.io/badge/sqlalchemy-ORM-D71F00?style=for-the-badge" alt="SQLAlchemy"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/sqlite-DB-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://gunicorn.org/"><img src="https://img.shields.io/badge/gunicorn-WSGI-499848?style=for-the-badge" alt="Gunicorn"></a>
  <a href="https://caddyserver.com/"><img src="https://img.shields.io/badge/caddy-proxy-1F88C0?style=for-the-badge" alt="Caddy"></a>
</p>
<p align="center">
  <a href="https://developers.google.com/youtube/v3"><img src="https://img.shields.io/badge/youtube%20data%20api-v3-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube Data API v3"></a>
  <a href="https://developers.google.com/identity/protocols/oauth2"><img src="https://img.shields.io/badge/google-oauth%202.0-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Google OAuth 2.0"></a>
  <a href="https://developer.mozilla.org/docs/Web/JavaScript"><img src="https://img.shields.io/badge/javascript-vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000" alt="JavaScript"></a>
  <a href="https://developer.mozilla.org/docs/Web/HTML"><img src="https://img.shields.io/badge/html5-frontend-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5"></a>
  <a href="https://developer.mozilla.org/docs/Web/CSS"><img src="https://img.shields.io/badge/css3-styles-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3"></a>
</p>

---

[Leer en Español](README_ES.md)

Your YouTube channels, zero noise 🎯

Hey! I’m GOTXE 👋, and YTCV came from something very simple:
I would open YouTube with a clear mission... and end up somewhere else 😅

That is not necessarily bad. Discovering new things is great.
But many times I wanted the opposite: open, check my subscriptions, catch up, and move on with my day 🚀

So I built this app for myself, and now I’m sharing it in case it helps you too.

YTCV is a self-hosted viewer to see **only** what matters to you:
your subscriptions, in chronological order, with a clean, direct, no-nonsense experience ✨



And remember: the real enemy is not the algorithm, it is procrastination. You are in control 💪

> [!IMPORTANT] IMPORTANT
Do not forget the YouTubers you like. They still need your direct support (subscriptions, likes, comments, merch, etc.) to keep creating quality content. Also use the official YouTube app for that and support your favorite creators.

## Index

- [What does YTCV do?](#what-does-ytcv-do)
- [Screenshots](#screenshots)
- [Usage](#usage)
- [First access (recommended flow)](#first-access-recommended-flow)
- [Login from other devices (passkey or code)](#login-from-other-devices-passkey-or-code)
- [OAuth without headaches](#oauth-without-headaches)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Support](#support)
- [Legal notice](#legal-notice)
- [License](#license)

## What does YTCV do?

- Imports your subscriptions with Google OAuth + YouTube Data API v3.
- Shows videos in real chronological order (as it should be 🫡).
- Lets you filter watched/unwatched and organize by categories.
- After first Google login, you create your local DB user so you can log in from any device with that user, without using Google again.
- Runs in containers (backend + proxy), ideal for self-hosting.

## Screenshots

### Main app

![YTCV login](screenshots/ytcv-login.png)
![Main web view](screenshots/ytcv-web.png)
![Playback in YTCV](screenshots/playing.png)

### Admin panel

![Admin panel - view 1](screenshots/Gestor_1.png)
![Admin panel - view 2](screenshots/Gestor_2.png)
![Admin panel - view 3](screenshots/Gestor_3.png)

## Usage

The recommended way is Docker Compose.

Storage modes (choose one):

1. Docker named volumes (no host folder management)
- No need to create host folders.
- Compose uses Docker-managed volumes (`ytcv_data`, `ytcv_logs`).

2. Host persistent folders (recommended on Synology)
- Create host folders, for example:

```text
/volume1/docker/ytclearview/
  ├─ data/
  └─ logs/
```

- Then map them as bind mounts in compose:

```yaml
services:
  backend:
    volumes:
      - /volume1/docker/ytclearview/data:/data
      - /volume1/docker/ytclearview/logs:/logs
```

Release and images:
- Release: `v0.13.0` -> <https://github.com/GOTXE/yt-clear-view/releases/tag/v0.13.0>
- Backend image: <https://github.com/GOTXE/yt-clear-view/pkgs/container/ytcv-backend>
- Proxy image: <https://github.com/GOTXE/yt-clear-view/pkgs/container/ytcv-proxy>
- Pull example:
```bash
docker pull ghcr.io/gotxe/ytcv-backend:v0.13.0
docker pull ghcr.io/gotxe/ytcv-proxy:v0.13.0
```

### 1) Prepare Google Cloud (quick searches)

Before launching YTCV, prepare this in Google Cloud. Here are direct searches:

- Create project in Google Cloud Console:
  - https://www.google.com/search?q=create+project+google+cloud+console
- Enable YouTube Data API v3:
  - https://www.google.com/search?q=enable+youtube+data+api+v3+google+cloud
- Create OAuth 2.0 credentials for web app:
  - https://www.google.com/search?q=create+oauth+client+id+web+application+google+cloud
- Configure OAuth consent screen:
  - https://www.google.com/search?q=configure+oauth+consent+screen+google+cloud
- Configure device login (Device Authorization / Device Flow):
  - https://www.google.com/search?q=google+oauth+2.0+device+authorization+grant

### 2) Standard install (normal use)

No local build, using GHCR images.

#### Step A: prepare your `.env`

Templates:
- [backend/.env.prod.example](backend/.env.prod.example)
- [backend/.env.dev.example](backend/.env.dev.example)

You have two options:

1. If you **cloned the full repo**:

```bash
cp backend/.env.prod.example backend/.env
```

2. If you **did NOT clone the repo** (for example, you use your own `docker-compose.yml`):
- Create a `.env` file in the same folder as your compose file.
- Fill it with the required variables.


```env
FLASK_SECRET_KEY=put_a_long_unique_secret_here
AUTH_MODE=google
YT_API_KEY=your_youtube_api_key
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5550/api/auth/google/callback
FRONTEND_URL=http://localhost:8080
CORS_ORIGINS=http://localhost:8080,http://localhost:5550
```

Options for `GOOGLE_REDIRECT_URI` `FRONTEND_URL` `CORS_ORIGINS` (choose one):

1. Localhost (no HTTPS)
- `GOOGLE_REDIRECT_URI=http://localhost:5550/api/auth/google/callback`
- Use this when everything runs on the same machine (browser + containers).
- It is the simplest local option. Google OAuth logins work fine with `localhost` without HTTPS. You will need to do Google login on that device first. After that first login, you can log in from any device with your local user without going through Google OAuth again.

2. External domain (with HTTPS)
- `GOOGLE_REDIRECT_URI=https://your-domain/api/auth/google/callback`
- Use this when you access from other devices or outside your local network.
- Google OAuth for web apps works reliably with a public hostname and HTTPS.
- In this scenario, also adjust these:
  - `FRONTEND_URL=https://your-domain`
  - `CORS_ORIGINS=https://your-domain`
- If frontend and API live on different domains, add both origins in `CORS_ORIGINS`:
  - `CORS_ORIGINS=https://your-frontend,https://your-api`

Minimum required values before starting Docker Compose:

- `FLASK_SECRET_KEY`
- `AUTH_TOKEN_ENCRYPTION_KEY`
- `YT_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `FRONTEND_URL`
- `CORS_ORIGINS`

Generate secrets with Python:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

#### Step B: start with your compose

The stack runs:
- `backend`: Flask API
- `proxy`: frontend + reverse proxy on `http://localhost:8080`

Example if you use the repo (`infra/compose/compose.yaml`):

```bash
YTCV_TAG=v0.13.0 docker compose -f infra/compose/compose.yaml up -d
```

You can customize startup with variables:

- `YTCV_TAG`: image version (`v0.13.0`, `latest`, etc.).
- `YTCV_HTTP_PORT`: public port (default `8080`).

Examples:

```bash
# Port 8090
YTCV_TAG=v0.13.0 YTCV_HTTP_PORT=8090 docker compose -f infra/compose/compose.yaml up -d
```

Basic equivalent compose example (if you want your own):

```yaml
services:
  backend:
    image: ghcr.io/gotxe/ytcv-backend:${YTCV_TAG:-latest}
    env_file:
      - ./.env
    environment:
      AUTH_MODE: google
      DATABASE_URI: sqlite:////data/youtube_clear_view.db
    volumes:
      - ytcv_data:/data
      - ytcv_logs:/logs

  proxy:
    image: ghcr.io/gotxe/ytcv-proxy:${YTCV_TAG:-latest}
    depends_on:
      - backend
    ports:
      - "${YTCV_HTTP_PORT:-8080}:8080"

volumes:
  ytcv_data:
  ytcv_logs:
```

Open:
- `http://localhost:8080`
- `https://your-domain` (if using external domain)

### First access (recommended flow)

1. Open the main web app:
- `http://localhost:8080` (local)
- `https://your-domain` (external domain)

2. Complete the first login with Google (OAuth).

3. Complete the initial wizard:
- create/configure your local app user,
- finish initial setup so you can sign in from other devices without repeating Google OAuth every time.

<span style="color:#d32f2f"><strong>IMPORTANT:</strong> On first boot (fresh database), admin/user bootstrap can take noticeably longer than a normal login. Wait until the wizard fully completes before retrying or refreshing.</span>

4. Access admin panel when needed:
- `http://localhost:8080/gestor/`
- `https://your-domain/gestor/`

### Login from other devices (passkey or code)

After first access and initial setup, you can sign in from other devices using:

1. Passkey (WebAuthn)
- Best for phones, laptops, and compatible browsers.
- Flow: on the new device choose passkey login and complete biometric/PIN verification.

2. Pairing code
- Best for TV or devices with uncomfortable text input.
- Flow: new device shows a code, you approve it from an already authenticated device, and the new device signs in.

Note:
- First account bootstrap still starts with Google OAuth.
- After that, these methods avoid repeating OAuth on every device.

### 3) DEV mode (for touching code with coffee :coffee: and faith :pray:)

Local build from repo for development and PRs.

```bash
cp backend/.env.dev.example backend/.env
# Edit backend/.env
./scripts/dev_docker.sh up --mode dev --build
```

Equivalent command:

```bash
docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d --build
```

### Useful commands

```bash
# Change public port
YTCV_HTTP_PORT=8081 YTCV_TAG=v0.13.0 docker compose -f infra/compose/compose.yaml up -d

# Update standard install
YTCV_TAG=v0.13.0 docker compose -f infra/compose/compose.yaml pull
YTCV_TAG=v0.13.0 docker compose -f infra/compose/compose.yaml up -d

# Rebuild proxy only (frontend)
./scripts/dev_docker.sh up --mode dev --build proxy

# Stop dev stack
./scripts/dev_docker.sh down --mode dev
```

> [!TIP] SUPER IMPORTANT
For frontend devs: watch browser cache. If you change frontend and do not bump `CACHE_VERSION` in `frontend/sw.js`, your browser may keep serving the old frontend from cache and make you think your changes did not work. Always rebuild `proxy` and bump `CACHE_VERSION` after frontend changes.
> The web app has a service worker and JS update notice. Click to load the new version.
> Otherwise, the browser may serve an old version and drive you crazy 🙃

## OAuth without headaches

You have two paths:

1. `localhost` callback (everything on same machine)
- `http://localhost:5550/api/auth/google/callback`

2. External domain callback (multi-device Google login)
- `https://your-domain/api/auth/google/callback`

Important:
- Avoid LAN IP callback over HTTP for Google OAuth.
- If it is not `localhost`, use HTTPS.

## Troubleshooting

- OAuth callback error:
  - `GOOGLE_REDIRECT_URI` must match exactly in Google Cloud Console and `backend/.env`.
- Port already in use:
  - change `YTCV_HTTP_PORT`.
- Backend is “healthy” but you cannot log in:
  - check `AUTH_MODE=google`, OAuth credentials, and consistency between `FRONTEND_URL` and `CORS_ORIGINS`. Also make sure you completed admin user setup and local DB user login (created after first Google login).
- Locked out after failed logins (`423` error):
  - after 5 failed password attempts an account is locked for 15 minutes. Wait it out, or restart the backend to lift the lock sooner.
- Forgot the admin/gestor password:
  - set `ADMIN_RESET_PASSWORD=true` in `backend/.env`, restart the backend, and check the backend logs — a new temporary password is generated for every admin account and printed there (you must change it on next login). Remove the variable and restart again once you are back in.
  - if you need to demote/disable all existing admins instead and go through the bootstrap wizard again, use `ADMIN_FORCE_RESET=true` (destructive: it disables all current admin accounts).
- Forgot a normal user's password:
  - an admin can set a temporary password for that user from the admin panel (`Gestor` → users → reset password). If no admin account is reachable, use the admin password reset above first.

## Documentation

🚧 W.I.P.: still under construction, but you can already take a look 👀
If you find anything weird or have questions, open an issue :paperclip:

- [Container install modes](docs/container-install-modes.md)
- [Deployment guide](docs/deployment.md)
- [Development guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api-reference.md)

## Support

Bug? :bug: Improvement idea? :bulb:

- Open a GitHub issue.
- Include version (`v0.13.0` or tag), environment, and reproduction steps.

## Legal notice

YTCV is an independent project and is not affiliated with YouTube/Google. It uses the official YouTube Data API v3 and follows its terms of use.

Your use of YTCV is your responsibility. Make sure you comply with Google and YouTube policies when using this tool.

And of course, YTCV and its author/developer are not responsible for any damage, data loss, or productivity addiction that may result from using this application. Use it in moderation and enjoy your distraction-free experience.




## License

MIT. See [LICENSE](LICENSE).
