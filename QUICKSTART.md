git submodule update --init --recursive
# Quick Start Guide – Automation MCP Server

This project ships with multiple MCP entry points. The default `index.ts` exposes generic automation tools (Playwright + command execution) so you can bootstrap new agents without any chat platform dependencies.

## 1. Install & Build

```bash
npm install
git submodule update --init --recursive
npm run build
```

## 2. Configure Environment

Copy `.env.example` to `.env` and add only the secrets you need. If you are running the Brunas or BSS servers, place their credentials here. The default automation server can run without any required variables.

## 3. Run a Server

```bash
# Core automation MCP server
npm start

# Domain servers
npm run start:brunas
npm run start:bss
npm run start:poller
```

Each command uses the compiled files under `dist/`. Remember to rebuild after making TypeScript changes.

## 4. Register with Copilot/Claude

Ensure `.vscode/mcp.json` points to the binaries you want enabled. The default configuration already wires up:

- `whatsapp` MCP server (Python)
- `playwright` helper
- `brunas-tms` Node server
- `bss-accounting` Node server

Start VS Code, open the Command Palette ➜ “GitHub Copilot: Restart MCP Servers” to reload the configuration.

## 5. Available Tools (default server)

- **execute_playwright** – Navigate, click, type, take screenshots, or wait using Playwright.
- **execute_command** – Execute a shell command with optional arguments (for tightly scoped automation).

Additional servers expose their own MCP tools (e.g., cadency search in Brunas, invoice lookups in BSS, WhatsApp automation flows).

## 6. Debugging Tips

- Use `npm run watch` to rebuild automatically while iterating.
- Run `npx playwright install chromium` if the executor complains about missing browsers.
- Confirm the server prints “Automation MCP Server started successfully” in the terminal.
- If MCP clients cannot connect, double-check `.vscode/mcp.json` paths and rerun the “Restart MCP Servers” command.

## 7. Next Steps

1. Connect your preferred LLM to the MCP endpoints.
2. Extend `PlaywrightExecutor` with custom actions if needed.
3. Build higher-level tools in `src/brunas-*.ts`, `src/bss-*.ts`, or new modules of your choice.

With Viber removed, the default server has zero chat platform dependencies—perfect for repurposing in other automation projects.
- Use webhooks instead of polling
- Cache expensive operations

Happy automating! 🎉
