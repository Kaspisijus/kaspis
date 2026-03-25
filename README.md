# Viber Agent MCP Server

A custom Model Context Protocol (MCP) server that bridges Viber Bot API with your AI agent, enabling real-time conversations and command execution through Viber.

## Features

- 💬 **Real-time Messaging**: Send and receive messages through Viber
- 🌐 **Web Automation**: Control browsers with Playwright commands
- 🤖 **AI Integration**: Connect to any AI agent or LLM
- 🔗 **Webhook Support**: Receive Viber messages via webhooks
- 🛠️ **Tool Execution**: Run shell commands and execute custom scripts
- 📱 **Multi-user**: Support multiple Viber conversations simultaneously

## Architecture

- **MCP Server**: Handles protocol communication with Claude/AI agents
- **Viber Bot API**: Integrates with Viber's bot platform
- **Playwright Executor**: Automates browser interactions
- **Webhook Server**: Receives real-time messages from Viber

## Prerequisites

- Node.js 18+ and npm/yarn
- Viber Business Account with Bot API access
- Playwright (automatically installed)
- MCP SDK (automatically installed)

## Setup

### 1. Install Dependencies

```bash
cd d:\dev\agent
npm install
git submodule update --init --recursive
```

The project depends on the `whatsapp-mcp` submodule for WhatsApp bridge files and MCP tooling.

### 2. Build the Project

```bash
npm run build
```

### 3. Configure Viber Bot

1. Go to [Viber Business Hub](https://www.viber.com/en/business/bot)
2. Create or select your bot
3. Get your Bot API Token
4. Create a `.env` file (copy from `.env.example`):

```bash
VIBER_BOT_TOKEN=your_actual_bot_token_here
WEBHOOK_PORT=3001
```

### 4. Set Up Webhook

Your Viber bot needs to know where to send messages. You have two options:

#### Option A: Use ngrok for local testing

```bash
# Install ngrok: https://ngrok.com/
ngrok http 3001
# You'll get a public URL like: https://xxx.ngrok.io
```

Then set the webhook in Viber Business Hub:
```
Webhook URL: https://xxx.ngrok.io/webhook/viber
```

#### Option B: Deploy to server

Set the webhook to your server's public URL:
```
Webhook URL: https://your-domain.com/webhook/viber
```

## Usage

### Run the MCP Server

```bash
npm run dev
# or
npm start
```

### Initialize MCP in VS Code

The server is configured in `.vscode/mcp.json`. When you use Claude/Copilot:

```
You can now:
- Send messages through Viber to your agent
- Execute Playwright browser commands
- Run system commands
- Browse the web
```

## Available Tools

### 1. send_viber_message
Send a message to a Viber user

```javascript
{
  "tool": "send_viber_message",
  "user_id": "viber_user_id",
  "message": "Hello from your agent!"
}
```

### 2. execute_playwright
Control browsers and automate web interactions

```javascript
{
  "tool": "execute_playwright",
  "action": "navigate",
  "url": "https://example.com"
}
```

Available actions:
- `navigate`: Navigate to a URL
- `click`: Click an element
- `type`: Type text into an element
- `screenshot`: Take a screenshot
- `get_title`: Get page title
- `wait`: Wait for specified milliseconds

### 3. get_conversation_history
Retrieve conversation history with a user

```javascript
{
  "tool": "get_conversation_history",
  "user_id": "viber_user_id"
}
```

### 4. execute_command
Execute system commands (use with caution)

```javascript
{
  "tool": "execute_command",
  "command": "ls",
  "args": ["-la"]
}
```

## Example Workflow

1. User sends message via Viber: "What's the weather?"
2. MCP Server receives webhook from Viber
3. Message is sent to Claude/Agent
4. Agent processes and responds with browser automation commands
5. Playwright executes browser actions
6. Response is sent back via Viber

## Project Structure

```
.
├── src/
│   ├── index.ts          # Main MCP server implementation
│   ├── viber.ts          # Viber Bot API integration
│   ├── playwright.ts     # Playwright browser executor
│   └── webhook.ts        # Express webhook server
├── dist/                 # Compiled JavaScript
├── .env.example         # Environment variables template
├── package.json         # Dependencies
├── tsconfig.json        # TypeScript configuration
└── .vscode/
    └── mcp.json         # MCP server configuration
```

## Development

### Watch mode with auto-compilation

```bash
npm run watch
```

Then in another terminal:
```bash
npm start
```

### Debug with VS Code

1. Press `F5` to start debugging
2. Set breakpoints in TypeScript files
3. Messages from Viber will trigger your breakpoints

## Environment Variables

- `VIBER_BOT_TOKEN`: Your Viber bot API token (required)
- `WEBHOOK_PORT`: Port for webhook server (default: 3001)
- `WEBHOOK_URL`: Public URL for Viber webhooks
- `DEBUG`: Enable debug logging (default: false)

## Security Considerations

- ✅ Always use HTTPS for webhooks in production
- ✅ Validate Viber webhook signatures
- ✅ Don't commit `.env` files with real tokens
- ✅ Use environment variables for sensitive data
- ✅ Implement rate limiting for commands
- ⚠️ Be cautious with `execute_command` - consider sandboxing

## Troubleshooting

### Webhook not receiving messages
- Verify webhook URL is publicly accessible
- Check Viber Bot API token is correct
- Ensure firewall/ports allow incoming connections
- Test with curl: `curl -X POST -H "Content-Type: application/json" -d '{"test":"data"}' https://your-url/webhook/viber`

### Playwright errors
- Ensure Playwright browser is installed: `npx playwright install chromium`
- Check selector syntax (CSS selectors or XPath)
- Verify page has loaded before taking actions

### MCP connection issues
- Check `.vscode/mcp.json` syntax
- Verify `dist/index.js` exists (run `npm run build`)
- Check Node.js version (need 18+)
- Review server logs for errors

## Next Steps

1. **Add LLM Integration**: Connect to OpenAI, Claude, or other LLMs
2. **Command Parser**: Create a command parser for natural language
3. **Database**: Add message persistence with database
4. **Advanced Keyboard**: Create custom Viber keyboards for rich UI
5. **Analytics**: Track conversations and usage

## Contributing

Feel free to extend this server with:
- Additional integrations (Slack, Discord, etc.)
- More Playwright actions
- Custom command handlers
- Database persistence
- Authentication/authorization

## License

ISC
