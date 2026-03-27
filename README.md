git submodule update --init --recursive
# Automation MCP Server

A lightweight Model Context Protocol (MCP) server that focuses on deterministic automation. It powers multiple integrations inside this repository: Playwright-driven browsing, Brunas TMS tooling, BSS accounting helpers, and WhatsApp automation. The default `index.ts` entry point now exposes only generic tools so it can run without any Viber dependencies.

## Features

- 🌐 **Playwright Automation** – Navigate, click, type, capture screenshots, or wait for events directly from MCP tools.
- 🛠️ **Shell/Command Execution** – Run controlled commands required by downstream adapters.
- 🧱 **Composable Design** – Additional domain-specific servers (Brunas TMS, BSS accounting, WhatsApp poller) live alongside the core automation server.
- ⚙️ **Headless Friendly** – Designed to run inside VS Code MCP tooling without extra services.

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   git submodule update --init --recursive
   ```
2. **Build TypeScript sources**
   ```bash
   npm run build
   ```
3. **Run the default MCP server**
   ```bash
   npm start
   ```

Use `.vscode/mcp.json` to register the server with Copilot/Claude. Additional specialized servers (Brunas, BSS, WhatsApp) have their own entry points under `dist/` and can be started via the scripts in `package.json`.

## Available Tools

### execute_playwright
Run Playwright actions from your agent.

```json
{
  "tool": "execute_playwright",
  "action": "navigate",
  "url": "https://example.com"
}
```

Supported actions: `navigate`, `click`, `type`, `screenshot`, `get_title`, `wait`. Provide additional parameters (`selector`, `text`, `delay`) as needed.

### execute_command
Execute a sanitized system command. Use sparingly and prefer dedicated integrations when possible.

```json
{
  "tool": "execute_command",
  "command": "dir",
  "args": ["/b"]
}
```

## Additional Entry Points

- `npm run start:brunas` – Launch the Brunas TMS MCP server.
- `npm run start:bss` – Launch the BSS accounting MCP server.
- `npm run start:poller` – Start the WhatsApp poller automation.

These services share the same build artifacts (`dist/*.js`) produced by `npm run build`.

## Project Structure

```
.
├── src/
│   ├── index.ts          # Core automation MCP server
│   ├── playwright.ts     # Playwright executor wrapper
│   ├── brunas-*.ts       # Brunas TMS tooling
│   ├── bss-*.ts          # BSS accounting tooling
│   └── whatsapp-*.ts     # WhatsApp automations
├── dist/                 # Compiled JavaScript
├── .env.example          # Environment template
├── .vscode/mcp.json      # MCP server registration
└── whatsapp-mcp/         # WhatsApp bridge submodule
```

## Environment Variables

Create a `.env` file (based on `.env.example`) and add only the secrets you need. For example:

```
BRUNAS_API_URL=https://example.com
BRUNAS_API_USERNAME=...
BRUNAS_API_PASSWORD=...
```

Other integrations (BSS, WhatsApp) have their own credentials; leave values unset if you are not running that service.

## Troubleshooting

- **TypeScript build fails** – Run `npm install` to ensure dependencies exist, then `npm run build`.
- **Playwright errors** – Install browsers via `npx playwright install chromium` and verify selectors.
- **MCP connection issues** – Confirm `.vscode/mcp.json` points to the correct executable and that the server prints “Automation MCP Server started successfully”.

## Contributing

Contributions are welcome! Expand the automation surface, add new MCP tools, or plug in additional transport layers. Keep the default server dependency-free (no Viber runtime) so it remains easy to embed in other projects.
- Database persistence
- Authentication/authorization

## License

ISC
