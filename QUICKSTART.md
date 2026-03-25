# Quick Start Guide - Viber Agent MCP Server

## 🚀 Setup (5 minutes)

### 1. Get Your Viber Bot Token

1. Go to [Viber Business Hub](https://www.viber.com/en/business/bot)
2. Sign up or log in
3. Create a new bot or select existing one
4. Copy your **Bot API Token** from the settings

### 2. Create .env File

```bash
# Copy the template
cp .env.example .env

# Edit and add your token
VIBER_BOT_TOKEN=your_bot_token_here
WEBHOOK_PORT=3001
```

### 3. Install Dependencies

```bash
npm install
git submodule update --init --recursive
```

Project already includes:
- TypeScript
- MCP SDK
- Playwright
- Axios
- Express

### 4. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

## 📱 Testing Locally

### Option 1: Using ngrok (Recommended for local development)

```bash
# 1. Install ngrok from https://ngrok.com/

# 2. Start ngrok in one terminal
ngrok http 3001

# You'll see:
# Forwarding    https://abc123def456.ngrok.io -> http://localhost:3001

# 3. Copy the ngrok URL

# 4. In Viber Business Hub, set webhook:
URL: https://abc123def456.ngrok.io/webhook/viber

# 5. Click "Test webhook" to verify

# 6. Start the MCP server (in another terminal)
npm run dev

# 7. Send a message in Viber to your bot
```

### Option 2: Using ngrok dynamically

```bash
# With ngrok pro, you can keep the same URL:
ngrok http 3001 --authtoken your_ngrok_token --domain your-custom-domain.ngrok.io
```

## 🤖 Using with Claude

The MCP server is configured in `.vscode/mcp.json`. It provides these tools:

### Send Viber Message
```
Tool: send_viber_message
Inputs:
  - user_id: The Viber user ID
  - message: Message text to send
```

### Browser Automation
```
Tool: execute_playwright
Inputs:
  - action: navigate | click | type | screenshot | get_title | wait
  - url: For navigate action
  - selector: CSS selector for element
  - text: Text to type
  - delay: Wait time in milliseconds
```

### Get Conversation
```
Tool: get_conversation_history
Inputs:
  - user_id: User ID to get history
```

### Execute Commands
```
Tool: execute_command
Inputs:
  - command: Command to run
  - args: Command arguments array
```

## 🛠️ Available npm Commands

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # Compile and run
npm start          # Run compiled code
npm run watch      # Watch for changes and recompile
```

## 📊 Project Structure

```
src/
├── index.ts         # MCP server implementation
├── viber.ts         # Viber Bot API wrapper
├── playwright.ts    # Browser automation
└── webhook.ts       # Express webhook server

.vscode/
└── mcp.json         # MCP configuration

dist/               # Compiled JavaScript (generated)
```

## 🔍 Debugging

### VS Code Debugging

1. Set breakpoints in `.ts` files
2. Press `F5` to start debugging
3. Send message in Viber to trigger code

### Check MCP Connection

```bash
# Verify the server starts without errors
npm run dev

# Should output:
# Viber Agent MCP Server started successfully
# Viber Bot Token: ✓
```

### Webhook Testing

```bash
# Test webhook endpoint
curl -X POST http://localhost:3001/webhook/viber \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "sender": {"id": "test_user_123"},
    "message": {"text": "Hello bot"}
  }'
```

## 🚨 Common Issues

### "Invalid Viber Bot Token"
- Get token from Viber Business Hub
- Make sure it's in `.env` as `VIBER_BOT_TOKEN`

### Webhook not receiving messages
- Check ngrok tunnel is active
- Verify webhook URL in Viber Business Hub
- Try "Test webhook" button in Viber

### MCP can't connect
- Ensure `dist/index.js` exists (run `npm run build`)
- Check `.vscode/mcp.json` has correct path
- Node.js version 18+ required

### Playwright browser errors
- Run `npx playwright install chromium`
- Check selector syntax is valid
- Wait for page to load before actions

## 📚 Full Documentation

See `README.md` for complete documentation including:
- Architecture overview
- Deployment guide
- Security considerations
- Integration examples
- Extending the server

See `.github/VIBER_MCP_GUIDE.md` for:
- Development guidelines
- Troubleshooting
- Performance tips
- Custom extensions

## 🎯 Next Steps

1. ✅ Send your first test message via Viber
2. Add bot intelligence (connect to LLM like Claude)
3. Create custom commands for your use case
4. Deploy to production server
5. Monitor and improve

## 💡 Tips

- Use Playwright to automate any web task
- Store user context in conversation history
- Add rate limiting for production
- Use webhooks instead of polling
- Cache expensive operations

Happy automating! 🎉
