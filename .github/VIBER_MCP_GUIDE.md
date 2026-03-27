# Automation MCP Server – Development Guide

This guide replaces the legacy Viber documentation and explains how to extend the automation-focused MCP services contained in this repository.

## Key References

- **MCP Specification** – https://modelcontextprotocol.io/specification/latest
- **TypeScript SDK** – https://github.com/modelcontextprotocol/typescript-sdk
- **Playwright** – https://playwright.dev/

## Core Architecture

1. `src/index.ts` – exposes generic tools (`execute_playwright`, `execute_command`).
2. `src/brunas-*.ts` – Brunas TMS-specific MCP server/helpers.
3. `src/bss-*.ts` – BSS accounting integration.
4. `src/whatsapp-*.ts` – WhatsApp poller + bridge utilities.

All entry points compile to `dist/` via `npm run build` and can be launched independently.

## Adding a Tool to the Default Server

```ts
// 1. Extend the tools array
tools.push({
	name: "my_tool",
	description: "Describe behaviour",
	inputSchema: {
		type: "object",
		properties: {
			param: { type: "string" }
		},
		required: ["param"]
	}
});

// 2. Handle the tool in CallToolRequestSchema
case "my_tool": {
	const value = args.param as string;
	// Do work
	return {
		content: [{ type: "text", text: `Processed ${value}` }]
	};
}
```

## Development Workflow

1. `npm run watch` – incremental TypeScript builds.
2. `npm start` – run the compiled automation server.
3. `npm run start:brunas` / `start:bss` / `start:poller` – start domain-specific services.
4. Restart MCP servers from VS Code after changing `.vscode/mcp.json`.

## Testing Playwright Actions

```bash
npm run build
node dist/index.js

# In another terminal, call the MCP server (via Copilot/Claude) with:
{"tool":"execute_playwright","action":"navigate","url":"https://example.com"}
```

Troubleshooting tips:
- Run `npx playwright install chromium` the first time.
- Use descriptive selectors and add `wait` actions between steps.
- Inspect the terminal output for serialized results/errors.

## Security Checklist

- Keep secrets in `.env` (never in source control).
- Restrict `execute_command` usage to trusted contexts.
- Validate all external inputs before passing them to APIs.
- Consider rate limits or authorization checks inside domain-specific servers.

## Common Issues

| Issue | Resolution |
| --- | --- |
| `Cannot find module './viber.js'` | Remove stale imports (Viber is no longer included) and rebuild. |
| Playwright timeout | Ensure the target selector exists, add waits, and confirm the page fully loads. |
| MCP client cannot connect | Verify `.vscode/mcp.json`, rerun `npm run build`, and restart MCP servers from VS Code. |

## Extending Beyond Playwright

Follow the patterns used in `brunas-server.ts` and `bss-server.ts` for additional APIs: define JSON schemas, wrap HTTP clients in `src/brunas-api.ts`, and surface them as MCP tools. Keep dependencies isolated so the default automation server remains lightweight.

---

By removing the Viber dependency the automation server now serves as a neutral starting point for any MCP-based workflow. Build specialized adapters in new files rather than reintroducing chat-platform-specific logic here.
