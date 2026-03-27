# EV Charging Cloud automation defaults

When the user asks to change pricing templates in EV Charging Cloud, execute the website actions directly with Playwright MCP tools instead of giving only theory.

Interpret these natural-language intents as commands:

1. "Change pricing template to \"<template>\" on charger <charger-name>"
- Open `https://manage.evchargingcloud.com/chargers`.
- Find the charger row by full charger name.
- Open the row three-dot action menu and click "Redaguoti".
- In "Redaguoti įkrovimo stotelę", find "Tarifas: ..." and click the edit pencil next to that line.
- In the "Redaguoti tarifą" dialog, type `<template>` in "Tarifo šablonas".
- Wait for autocomplete and select the matching template option (exact match first, case-insensitive fallback).
- Click "Išsaugoti" in the tariff dialog.
- Close the "Redaguoti įkrovimo stotelę" dialog.
- Report success with charger name and selected template.

2. "Change pricing template to \"<template>\" to all chargers"
- Open `https://manage.evchargingcloud.com/chargers`.
- Apply the same edit flow to every charger visible in the list, then continue through remaining pages if pagination exists.
- For each charger: three-dot menu -> "Redaguoti" -> "Tarifas" line edit -> type/select template in "Tarifo šablonas" -> "Išsaugoti" -> close charger dialog.
- Keep a count of updated chargers and report the final count.

Technical implementation notes (Vuetify autocomplete):
- Use `pressSequentially()` (character-by-character typing) instead of `fill()` to trigger autocomplete.
- Wait ~1s after typing for dropdown to appear.
- Select from dropdown via `.menuable__content__active .v-list-item` filtered by template name.
- Verify selection by checking the "Pavadinimas*" field value changed to match the template.

Safety and reliability rules:
- If a target charger is not found, report "not found" and do not update other chargers unless explicitly requested.
- If multiple templates have similar names, choose exact match first, otherwise ask for confirmation.
- After each save, verify a success toast/message or re-open tariff section to confirm template value.
- Do not store or print credentials in files.

---

# Automation MCP Server

This repo contains two main runtime modes:

1. **Local MCP servers** — stdio-based servers for VS Code Copilot/Claude (`src/index.ts`, `src/brunas-server.ts`, `src/bss-server.ts`, `src/whatsapp-poller.ts`).
2. **Live agent HTTP server** — `src/agent-server.ts`, deployed at **https://agent.brunas.lt** with Open WebUI as the chat frontend.

## Local MCP Details

**Configuration**: `.vscode/mcp.json` – registers all available MCP servers
**Source**: `src/` directory – TypeScript implementation

### Before Starting Development
1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` (fill in only the variables you need)
3. Build: `npm run build`
4. Consult README.md for usage notes

### Local Server Capabilities
- Tool: `execute_playwright` – Browser automation (navigate, click, type, screenshot, wait, get_title)
- Tool: `execute_command` – Execute guarded system commands

Additional Node services (Brunas TMS, BSS accounting, WhatsApp poller) expose their own MCP tools via separate entry points in `dist/`.

## Live Deployment — agent.brunas.lt

### Architecture
- **Hetzner CX32** VPS (4 vCPU / 8 GB RAM), Ubuntu 24.04, IP `167.235.226.121`
- **Docker Compose** with 4 services: `agent`, `open-webui`, `nginx`, `certbot`
- **SSL**: Let's Encrypt cert for `agent.brunas.lt` (auto-renewal via certbot)
- **DNS**: `agent.brunas.lt` → `167.235.226.121`
- **SSH**: `ssh -i D:\inspiron_priv root@167.235.226.121`
- **Deployed files**: `/opt/agent/` on the server

### Services

| Service | Image / Build | Port | Role |
|---------|--------------|------|------|
| `agent` | Built from `Dockerfile` | 3002 (internal) | Express API server — auth, OpenAI-compatible `/v1/chat/completions`, tool execution loop |
| `open-webui` | `ghcr.io/open-webui/open-webui:main` | 8080 (internal) | Chat UI frontend, connects to agent as its OpenAI backend |
| `nginx` | `nginx:alpine` | 80, 443 (exposed) | Reverse proxy, SSL termination, `auth_request` session validation |
| `certbot` | `certbot/certbot` | — | SSL cert management (profile-gated, run manually) |

### Auth Flow
1. User visits `https://agent.brunas.lt/` → nginx redirects unauthenticated users to `/auth/login`
2. Agent serves login page → user enters Brunas TMS credentials
3. Agent authenticates against `auth.brunas.lt`, creates in-memory session (8h TTL), sets `agent_sid` cookie
4. nginx `auth_request` calls `/auth/validate` on every request → gets back `X-User-Email` header
5. nginx forwards `X-User-Email` to Open WebUI → trusted header auto-login (`WEBUI_AUTH_TRUSTED_EMAIL_HEADER`)

### Access Control
- **Superadmins** (Brunas `super=true`): full access to all Brunas companies + BSS accounting tools + admin tools
- **Regular users**: scoped to their own Brunas TMS companies only
- Admin in Open WebUI: `kasparas.ziuraitis@gmail.com`

### Agent Server Endpoints
- `POST /auth/login` — Brunas TMS login
- `POST /auth/select-client` — choose active Brunas company
- `GET  /auth/me` — current session info
- `POST /auth/logout` — destroy session
- `GET  /auth/validate` — internal (nginx auth_request)
- `GET  /v1/models` — OpenAI-compatible model list (returns `brunas-agent`)
- `POST /v1/chat/completions` — OpenAI-compatible chat with tool-calling loop (max 15 iterations)

### Key Environment Variables (server `.env`)
- `AGENT_API_KEY` — shared secret between agent and Open WebUI
- `OPENAI_API_KEY` — GitHub Models / OpenAI API key for LLM calls
- `OPENAI_BASE_URL` — LLM endpoint (default: `https://models.inference.ai.azure.com`)
- `LLM_MODEL` — model name (default: `gpt-4o-mini`)

### Deploying Changes
```bash
# From local machine — upload, rebuild, restart
scp -i D:\inspiron_priv -r dist/ root@167.235.226.121:/opt/agent/dist/
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose up -d --build agent"

# Or rebuild everything:
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose up -d --build"
```

### Cert Renewal
```bash
ssh -i D:\inspiron_priv root@167.235.226.121 "cd /opt/agent && docker compose run --rm certbot renew && docker compose exec nginx nginx -s reload"
```

### MCP References
- MCP Documentation: https://modelcontextprotocol.io/
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Playwright Docs: https://playwright.dev/

---

# WhatsApp + Brunas TMS Access Control

When processing WhatsApp messages that request Brunas TMS data (carriages, drivers, vehicles), you MUST enforce the following allowlist. Only these phone numbers are authorized to query or modify Brunas TMS via WhatsApp:

| Phone | Name |
|-------|------|
| +37067536696 | Mantas |
| +37060889319 | Vilius |

Rules:
- Before executing any Brunas TMS tool (`find_carriages`, `find_drivers`, `find_vehicles`, `get_carriage`, `get_driver`, `get_vehicle`) in response to a WhatsApp message, verify the sender's phone number is in the allowlist above.
- If the sender is NOT in the allowlist, reply via WhatsApp: "Atsiprašome, jūs neturite prieigos prie šios sistemos." (Sorry, you don't have access to this system.) Do NOT execute any TMS tool.
- If the sender IS in the allowlist, proceed normally and address them by name.
- This restriction applies only to Brunas TMS tools. Other WhatsApp interactions (general chat) are not restricted.

---

# Brunas TMS — Carriage Display Rules

When displaying carriage data (from `find_carriages` or `get_carriage`), ALWAYS include the tasks (route) for each carriage. Task types: `5` = Loading, `0` = Unloading, `1` = Fuel, `2` = CarWash, `3` = Service.

Format each carriage as:
```
Carriage #<prettyId> | <status> | <date> → <endDate>
Vehicle: <vehicle.number> | Driver: <driverName> | Customer: <customer.name> | Price: <price> EUR

Tasks:
1. <name> (<type>) — <placeName>, <address>
2. <name> (<type>) — <placeName>, <address>
...
```

---

# Brunas TMS — Truck-Trailer Linking Rules

When creating or editing a truck-trailer link, mirror the UI flow used in "Pridėti priekabą".

Required flow:
- For create: use `POST /api/v3/vehicle-trailers/`.
- For edit: use `PUT /api/v3/vehicle-trailers/{id}/edit`.
- Before create/edit, ALWAYS call intersecting precheck:
	- `POST /api/v3/vehicle-trailers/trailers/{trailerId}/intersecting`
	- Payload: `{ "dateFrom": "YYYY-MM-DD", "dateTo": null|"YYYY-MM-DD", "skipVehicleId": <vehicleId>, "skipTrailerId": null|<vehicleTrailerId> }`
- For finish: use `POST /api/v3/vehicle-trailers/{id}/finish` with `dateTo`.
- For delete: use `DELETE /api/v3/vehicle-trailers/{id}/delete`.

Payload reliability rules:
- `dateFrom` and `dateTo` must be serialized as `YYYY-MM-DD`.
- `dateTo` may be `null` for open-ended links.
- If resolved vehicle payload is missing `expedition`, set `expedition: false` before create/edit request.

Behavior rules:
- Include precheck result in operation output when possible.
- If precheck finds intersecting links, show those conflicts to the user before continuing.

---

# Brunas TMS — Vehicle Search Strategy

When searching for a vehicle by plate number (e.g. "surask vilkiką ABC001"):

1. Use `search_vehicles` — it automatically searches active vehicles first, then falls back to all statuses (disassembled, sold, archived) if nothing is found.
2. Check the `_source` field in the response:
   - Missing or absent → found among active vehicles.
   - `"find_vehicles_fallback"` → found among inactive/disassembled vehicles. Always mention the vehicle's status to the user.
   - `"no_results"` → not found at all. Suggest partial plate search or alternative queries.
3. If the user asks to "find a truck" and the result is a trailer (different entity), clearly state it is a trailer, not a truck.

---

# Brunas TMS — Admin Knowledge Base

The agent maintains a knowledge base file at `.github/brunas-knowhow.md` in this repository.
This file contains lessons learned, common pitfalls, and verified patterns discovered during real usage.

**How it works:**
- When the administrator (user) tells the agent something like "zapamiętaj" / "prisimink" / "remember this" / "įsidėk", the agent MUST append the insight to `.github/brunas-knowhow.md`.
- Before executing Brunas TMS operations, the agent SHOULD consult `.github/brunas-knowhow.md` for relevant tips.
- The administrator can also say "parodyk knowhow" / "show knowhow" to review the current knowledge base.
- Entries should be concise bullet points grouped by topic (Vehicles, Trailers, Carriages, Cadencies, Drivers, General).

**Format:**
```markdown
## Vehicles
- `search_vehicles` auto-falls back to all statuses. If vehicle has status 1 (disassembled), mention it explicitly.
- Vehicle status values: 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted.

## Trailers
- (tips here)

## Carriages
- (tips here)

## General
- (tips here)
```
