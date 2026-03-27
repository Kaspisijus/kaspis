#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
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

// Initialize Playwright executor for browser and system actions
const playwrightExecutor = new PlaywrightExecutor();

// Initialize MCP Server
const server = new Server({
  name: "automation-agent-mcp",
  version: "1.0.0",
});

// Tool definitions
const tools = [
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

// Start the MCP server
async function main() {
  // Load environment variables
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Automation MCP Server started successfully");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// Export for testing
export { server };
