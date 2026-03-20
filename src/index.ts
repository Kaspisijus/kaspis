#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { ViberBotAPI } from "./viber.js";
import { PlaywrightExecutor } from "./playwright.js";

// Simple error classes
class McpError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "McpError";
  }
}

const ErrorCode = {
  InvalidRequest: "InvalidRequest",
  MethodNotFound: "MethodNotFound",
  InternalError: "InternalError",
};

// Initialize Viber Bot and Playwright
const viberBot = new ViberBotAPI(process.env.VIBER_BOT_TOKEN || "");
const playwrightExecutor = new PlaywrightExecutor();

// Store conversation history per user
const conversationHistory = new Map<
  string,
  Array<{ role: string; content: string }>
>();

// Initialize MCP Server
const server = new Server({
  name: "viber-agent-mcp",
  version: "1.0.0",
});

// Tool definitions
const tools = [
  {
    name: "send_viber_message",
    description:
      "Send a message to a Viber user. Use this to respond to user messages.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "string",
          description: "The Viber user ID to send the message to",
        },
        message: {
          type: "string",
          description: "The message text to send",
        },
      },
      required: ["user_id", "message"],
    },
  },
  {
    name: "execute_playwright",
    description:
      "Execute Playwright browser automation commands. Use for web browsing, testing, and automation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate",
            "click",
            "type",
            "screenshot",
            "get_title",
            "wait",
          ],
          description: "The Playwright action to perform",
        },
        url: {
          type: "string",
          description: "URL to navigate to (for navigate action)",
        },
        selector: {
          type: "string",
          description: "CSS selector or XPath for the element",
        },
        text: {
          type: "string",
          description: "Text to type (for type action)",
        },
        delay: {
          type: "number",
          description: "Delay in milliseconds (for wait action)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "get_conversation_history",
    description:
      "Retrieve the conversation history with a specific Viber user",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "string",
          description: "The Viber user ID",
        },
      },
      required: ["user_id"],
    },
  },
  {
    name: "execute_command",
    description:
      "Execute custom commands or shell commands (be careful with this)",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to execute",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
      },
      required: ["command"],
    },
  },
];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: toolArgs } = request.params;

  if (typeof toolArgs !== "object" || toolArgs === null) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Invalid arguments"
    );
  }

  const args = toolArgs as Record<string, unknown>;

  switch (toolName) {
    case "send_viber_message": {
      const userId = args.user_id as string;
      const message = args.message as string;

      if (!userId || !message) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "user_id and message are required"
        );
      }

      const success = await viberBot.sendMessage(userId, message);

      return {
        content: [
          {
            type: "text" as const,
            text: success
              ? `Message sent to ${userId}`
              : `Failed to send message to ${userId}`,
          },
        ],
      };
    }

    case "execute_playwright": {
      const action = args.action as string;

      try {
        const result = await playwrightExecutor.execute({
          action,
          url: args.url as string | undefined,
          selector: args.selector as string | undefined,
          text: args.text as string | undefined,
          delay: args.delay as number | undefined,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new McpError(
          ErrorCode.InternalError,
          `Playwright error: ${errorMessage}`
        );
      }
    }

    case "get_conversation_history": {
      const userId = args.user_id as string;

      if (!userId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "user_id is required"
        );
      }

      const history = conversationHistory.get(userId) || [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(history),
          },
        ],
      };
    }

    case "execute_command": {
      const command = args.command as string;
      const cmdArgs = args.args as string[] | undefined;

      if (!command) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "command is required"
        );
      }

      try {
        // This is a simple implementation. In production, use a safer command execution method.
        // For now, this is a placeholder that demonstrates the interface.
        const result = await playwrightExecutor.executeSystemCommand(
          command,
          cmdArgs
        );
        return {
          content: [
            {
              type: "text" as const,
              text: result,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new McpError(
          ErrorCode.InternalError,
          `Command error: ${errorMessage}`
        );
      }
    }

    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${toolName}`
      );
  }
});

// Viber webhook handler
async function handleViberMessage(
  userId: string,
  message: string
) {
  // Store message in conversation history
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId)!;
  history.push({ role: "user", content: message });

  // Here you would typically:
  // 1. Send the message to your agent/LLM
  // 2. Get a response
  // 3. Execute any requested tools/commands
  // 4. Send the response back to the user

  const responseMessage = `Received: "${message}". I'm ready to help! Use commands like: browse <url>, click <selector>, type <text>`;

  history.push({ role: "assistant", content: responseMessage });

  // Send response back to Viber
  await viberBot.sendMessage(userId, responseMessage);
}

// Start the MCP server
async function main() {
  // Load environment variables
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Viber Agent MCP Server started successfully");
  console.error(`Viber Bot Token: ${process.env.VIBER_BOT_TOKEN ? "✓" : "✗"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// Export for testing
export { server, handleViberMessage, conversationHistory };
