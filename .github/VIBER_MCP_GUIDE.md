# Viber Agent MCP Server - Development Guide

This document contains development guidelines and references for the Viber Agent MCP Server.

## SDK Documentation

- **MCP SDK**: https://modelcontextprotocol.io/
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Viber Bot API**: https://developers.viber.com/docs/api/rest-bot-api/

## Key Concepts

### Model Context Protocol (MCP)

MCP is an open protocol that enables seamless integration between LLM applications and external data sources/tools. This server implements the MCP server interface to expose tools that Claude and other agents can use.

### Viber Bot API

Viber's bot API allows you to:
- Send/receive messages
- Send rich media (images, videos, files)
- Receive user events (subscriptions, online status)
- Set up webhooks for real-time updates

## Implementation Details

### Message Flow

1. User sends message in Viber
2. Viber sends webhook POST to your server
3. `ViberBotAPI.parseWebhookPayload()` parses the message
4. `handleViberMessage()` processes it and communicates with LLM
5. LLM may use tools (Playwright, commands, etc.)
6. Response is sent back via `sendMessage()`

### Tool Definitions

Tools are defined in `src/index.ts` using the MCP ToolDefinition schema:
- `name`: Unique tool identifier
- `description`: What the tool does
- `inputSchema`: JSON schema for tool inputs

Standard MCP tools:
- `send_viber_message`: Send Viber messages
- `execute_playwright`: Browser automation
- `get_conversation_history`: Message history
- `execute_command`: System commands

## Testing

### Manual Testing

```bash
# 1. Start the MCP server
npm run dev

# 2. In another terminal, test webhook
curl -X POST http://localhost:3001/webhook/viber \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message",
    "sender": {"id": "test_user_123"},
    "message": {"text": "Hello bot"}
  }'
```

### Testing with ngrok

```bash
# 1. Start ngrok
ngrok http 3001

# 2. Get public URL (e.g., https://abc123.ngrok.io)

# 3. Set webhook in Viber Business Hub

# 4. Send message in Viber and monitor logs
```

## Performance Considerations

- **Playwright**: Browser launches can be slow (2-5s). Consider reusing the page.
- **Viber API**: Rate limits apply. Cache responses where possible.
- **Memory**: Keep conversation history limited (e.g., last 100 messages per user)

## Security Best Practices

### Authentication
- Validate webhook signatures from Viber
- Use HTTPS always in production
- Store tokens in encrypted environment variables

### Input Validation
- Sanitize user messages before acting on them
- Validate selectors in Playwright commands
- Use allowlist for executable commands

### Rate Limiting
- Limit message frequency per user
- Limit command execution per minute
- Implement cooldown periods for expensive operations

## Error Handling

The server implements error handling at multiple levels:

1. **API Level**: Catch and return MCP errors
2. **Viber Level**: Handle API failures gracefully
3. **Playwright Level**: Manage browser errors
4. **System Level**: Validate all inputs

## Extending the Server

### Adding New Tools

```typescript
// In src/index.ts
{
  name: "my_new_tool",
  description: "What it does",
  inputSchema: {
    type: "object",
    properties: {
      param1: { type: "string" }
    },
    required: ["param1"]
  }
}

// In the request handler
case "my_new_tool": {
  // Implementation
  break;
}
```

### Adding New Viber Features

```typescript
// In src/viber.ts
async myNewFeature(userId: string) {
  // Implementation using axios
}
```

### Custom Webhook Handlers

```typescript
// In src/webhook.ts
app.post("/webhook/custom", (req, res) => {
  // Your custom handler
  res.status(200).json({ status: "ok" });
});
```

## Deployment

### Prerequisites
- Node.js 18+ server
- Public HTTPS URL
- Environment variables configured

### Steps
1. Clone repository to server
2. Install dependencies: `npm install`
3. Build project: `npm run build`
4. Set environment variables in `.env`
5. Start server: `npm start`
6. Set webhook URL in Viber Business Hub

### Using PM2 for Process Management

```bash
npm install -g pm2
pm2 start dist/index.js --name viber-mcp
pm2 save
pm2 startup
```

## References

- MCP Specification: https://modelcontextprotocol.io/specification/latest
- Viber API Docs: https://developers.viber.com/docs/api/rest-bot-api/
- Playwright Docs: https://playwright.dev/
- Node.js Docs: https://nodejs.org/docs/

## Common Issues and Solutions

### Webhook not receiving messages
**Problem**: Viber webhook not triggering
**Solution**: 
- Verify webhook URL is publicly accessible
- Check bot API token is valid
- Ensure webhook handler returns 200 status

### Playwright timeout
**Problem**: `Playwright timeout waiting for selector`
**Solution**:
- Increase timeout value
- Wait for page load with `waitForLoadState()`
- Verify selector exists on page

### MCP connection fails
**Problem**: `Error connecting to MCP server`
**Solution**:
- Verify `.vscode/mcp.json` syntax
- Run `npm run build` to generate dist/
- Check Node.js version >= 18
- Review server logs for errors
