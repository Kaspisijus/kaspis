# Quick Start Guide

## Local Development (MCP Servers)

```bash
npm install
git submodule update --init --recursive
cp .env.example .env   # fill in credentials you need
npm run build
```

### Run a server

```bash
npm start              # Core automation (Playwright + shell)
npm run start:brunas   # Brunas TMS MCP server
npm run start:bss      # BSS accounting MCP server
npm run start:poller   # WhatsApp poller
npm run start:agent    # HTTP agent server (local)
```

### Register with VS Code

Ensure `.vscode/mcp.json` has the correct paths, then: Command Palette → "GitHub Copilot: Restart MCP Servers".

## Live Agent Server (agent.brunas.lt)

The agent HTTP server runs on a Hetzner VPS behind nginx + Open WebUI.

### First-time server setup

```bash
# SSH into server
ssh -i D:\inspiron_priv root@167.235.226.121

# Files are at /opt/agent/
cd /opt/agent

# Create .env with required variables:
#   AGENT_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL

# Start all services
docker compose up -d --build
```

### Deploy code changes

```bash
# Build locally
npm run build

# Upload compiled JS and rebuild agent container
scp -i D:\inspiron_priv -r dist/ root@167.235.226.121:/opt/agent/dist/
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose up -d --build agent"
```

### Check logs

```bash
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose logs -f agent"
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose logs -f open-webui"
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose logs -f nginx"
```

### SSL cert renewal

```bash
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose run --rm certbot renew && docker compose exec nginx nginx -s reload"
```

## Available Tools (default MCP server)

- **execute_playwright** — Navigate, click, type, take screenshots via Playwright.
- **execute_command** — Execute a shell command with optional arguments.

Additional servers expose domain-specific tools (Brunas TMS: 30 tools, BSS accounting: 2 tools).

## Debugging Tips

- Run `npm run watch` to rebuild automatically while iterating.
- Run `npx playwright install chromium` if the executor reports missing browsers.
- Confirm the server prints startup messages in the terminal.
- If MCP clients cannot connect, check `.vscode/mcp.json` paths and rerun "Restart MCP Servers".
