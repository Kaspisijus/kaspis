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

The default MCP entry point (`src/index.ts`) now provides a lightweight automation toolset without any chat-platform dependencies. It focuses on:
- Executing Playwright browser commands
- Running tightly scoped system commands
- Acting as a base layer for additional integrations (Brunas TMS, BSS accounting, WhatsApp poller)

## Server Details

**Configuration**: `.vscode/mcp.json` – registers all available MCP servers
**Source**: `src/` directory – TypeScript implementation
**Documentation**: `.github/VIBER_MCP_GUIDE.md` – updated development guide

### Before Starting Development
1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` (fill in only the variables you need)
3. Build: `npm run build`
4. Consult README.md for usage notes

### Server Capabilities
- Tool: `execute_playwright` – Browser automation (navigate, click, type, screenshot, wait, get_title)
- Tool: `execute_command` – Execute guarded system commands

Additional Node services (Brunas TMS, BSS accounting, WhatsApp poller) expose their own MCP tools via separate entry points in `dist/`.

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
