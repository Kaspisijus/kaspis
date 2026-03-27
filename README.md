# Automation MCP Server

A Model Context Protocol (MCP) server with multiple integrations: Playwright browser automation, Brunas TMS, BSS accounting, and WhatsApp. Also includes a live **agent HTTP server** deployed at **https://agent.brunas.lt** with Open WebUI as the chat frontend.

## Runtime Modes

### 1. Local MCP Servers (stdio)

Lightweight servers that run inside VS Code via Copilot / Claude MCP tooling.

| Entry point | Script | Description |
|---|---|---|
| `src/index.ts` | `npm start` | Core automation (Playwright + command execution) |
| `src/brunas-server.ts` | `npm run start:brunas` | Brunas TMS tools (30 tools) |
| `src/bss-server.ts` | `npm run start:bss` | BSS accounting tools |
| `src/whatsapp-poller.ts` | `npm run start:poller` | WhatsApp message poller |

Register with VS Code via `.vscode/mcp.json`.

### 2. Live Agent Server (HTTP)

Express HTTP server (`src/agent-server.ts`) that exposes an OpenAI-compatible API. Deployed at `https://agent.brunas.lt` with Open WebUI as the frontend.

```bash
npm run start:agent
```

See [Live Deployment](#live-deployment--agentbrunaslt) below for production setup.

## Getting Started

```bash
npm install
git submodule update --init --recursive
cp .env.example .env   # fill in required variables
npm run build
```

## Project Structure

```
.
├── src/
│   ├── index.ts              # Core automation MCP server (Playwright + shell)
│   ├── agent-server.ts       # Live HTTP agent server (OpenAI-compatible API)
│   ├── playwright.ts         # Playwright executor wrapper
│   ├── brunas-api.ts         # Brunas TMS API client
│   ├── brunas-server.ts      # Brunas TMS MCP server (stdio)
│   ├── bss-server.ts         # BSS accounting MCP server (stdio)
│   ├── whatsapp-poller.ts    # WhatsApp message poller
│   └── shared/
│       ├── auth.ts           # Brunas auth (login, client resolution)
│       └── tool-defs.ts      # 34 shared tool definitions
├── nginx/
│   └── default.conf          # nginx reverse proxy config
├── docker-compose.yml        # 4-service Docker Compose stack
├── Dockerfile                # Agent server container image
├── dist/                     # Compiled JavaScript
├── .env.example              # Environment template
├── .vscode/mcp.json          # MCP server registration
└── whatsapp-mcp/             # WhatsApp bridge submodule (Go + Python)
```

## Environment Variables

Create a `.env` file based on `.env.example`. Key variables:

| Variable | Required for | Description |
|---|---|---|
| `OPENAI_API_KEY` | Agent server | GitHub Models / OpenAI API key |
| `OPENAI_BASE_URL` | Agent server | LLM endpoint (default: `https://models.inference.ai.azure.com`) |
| `LLM_MODEL` | Agent server | Model name (default: `gpt-4o-mini`) |
| `AGENT_API_KEY` | Agent server | Shared secret between agent and Open WebUI |
| `AGENT_PORT` | Agent server | HTTP port (default: `3002`) |
| `BRUNAS_API_URL` | Brunas MCP | Brunas TMS API base URL |
| `BRUNAS_API_USERNAME` | Brunas MCP | Brunas login credentials |
| `BRUNAS_API_PASSWORD` | Brunas MCP | Brunas login credentials |
| `BSS_API_URL` | BSS MCP | BSS accounting API URL |
| `BSS_USERNAME` | BSS MCP | BSS login credentials |
| `BSS_PASSWORD` | BSS MCP | BSS login credentials |

## Live Deployment — agent.brunas.lt

### Architecture

- **Server**: Hetzner CX32 (4 vCPU / 8 GB RAM), Ubuntu 24.04, IP `167.235.226.121`
- **SSL**: Let's Encrypt cert for `agent.brunas.lt`
- **SSH**: `ssh -i D:\inspiron_priv root@167.235.226.121`
- **Deployed files**: `/opt/agent/`

### Docker Compose Services

| Service | Image | Port | Role |
|---------|-------|------|------|
| `agent` | Built from `Dockerfile` (Node 22) | 3002 (internal) | Express API — auth, `/v1/chat/completions`, tool-calling loop |
| `open-webui` | `ghcr.io/open-webui/open-webui:main` | 8080 (internal) | Chat UI, connects to agent as its OpenAI backend |
| `nginx` | `nginx:alpine` | 80, 443 (exposed) | Reverse proxy, SSL termination, `auth_request` session validation |
| `certbot` | `certbot/certbot` | — | SSL cert management (profile-gated) |

### Auth Flow

1. User visits `https://agent.brunas.lt/` → nginx `auth_request` validates `agent_sid` cookie
2. No valid session → nginx redirects to `/auth/login` (served by agent)
3. User enters Brunas TMS credentials → agent authenticates against `auth.brunas.lt`
4. Agent creates in-memory session (8h TTL), sets `agent_sid` cookie
5. On subsequent requests, nginx validates cookie via `/_auth_check` → passes `X-User-Email` to Open WebUI
6. Open WebUI receives trusted `X-User-Email` header → auto-creates/logs in user

### Access Control

- **Superadmins** (`super=true` in Brunas): all Brunas companies + BSS accounting + admin tools
- **Regular users**: scoped to their own Brunas TMS companies only
- Open WebUI admin: `kasparas.ziuraitis@gmail.com`

### Agent API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Brunas TMS login (returns session cookie) |
| `POST` | `/auth/select-client` | Choose active Brunas company |
| `GET` | `/auth/me` | Current session info |
| `POST` | `/auth/logout` | Destroy session |
| `GET` | `/auth/validate` | Internal — nginx auth_request |
| `GET` | `/v1/models` | OpenAI-compatible model list (`brunas-agent`) |
| `POST` | `/v1/chat/completions` | Chat with tool-calling loop (max 15 iterations) |

### Deploying Changes

```bash
# Build locally
npm run build

# Upload and rebuild agent container
scp -i D:\inspiron_priv -r dist/ root@167.235.226.121:/opt/agent/dist/
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose up -d --build agent"

# Rebuild all services
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose up -d --build"
```

### SSL Cert Renewal

```bash
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose run --rm certbot renew && docker compose exec nginx nginx -s reload"
```

## Troubleshooting

- **TypeScript build fails** — Run `npm install`, then `npm run build`.
- **Playwright errors** — Install browsers via `npx playwright install chromium`.
- **MCP connection issues** — Check `.vscode/mcp.json` paths; run "Restart MCP Servers" in VS Code.
- **Agent server issues** — Check logs: `ssh ... "cd /opt/agent && docker compose logs agent"`.
- **Open WebUI issues** — Check logs: `ssh ... "cd /opt/agent && docker compose logs open-webui"`.

## License

ISC
