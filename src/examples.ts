/**
 * Example: Integrating Claude with Viber Bot
 * 
 * This shows how to connect the MCP server to Claude or other LLMs
 * for intelligent conversation and command execution.
 */

// Example 1: Using with Claude via Anthropic API
/*
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function handleUserMessage(userId: string, userMessage: string) {
  const client = new Anthropic();

  const message = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    system: `You are a helpful Viber bot assistant. You can browse the web and execute commands.
      When the user asks you to do something, use the available tools.
      - Use execute_playwright to browse and automate websites
      - Use send_viber_message to send responses
      - You can take screenshots, navigate URLs, click buttons, type text.`,
    tools: [
      {
        name: "execute_playwright",
        description: "Execute browser automation actions",
        input_schema: {
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
            },
            url: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            delay: { type: "number" },
          },
        },
      },
      {
        name: "send_viber_message",
        description: "Send message back to user",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  console.log("Claude response:", message);

  // Process tool uses
  for (const block of message.content) {
    if (block.type === "tool_use") {
      const toolName = block.name;
      const toolInput = block.input as Record<string, unknown>;

      if (toolName === "execute_playwright") {
        // Call your MCP tool
        console.log(`Executing: ${toolInput.action}`);
      } else if (toolName === "send_viber_message") {
        // Send message back to user
        console.log(`Sending: ${toolInput.message}`);
      }
    }
  }
}
*/

// Example 2: Using OpenAI with function calling
/*
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function handleWithOpenAI(userId: string, userMessage: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant that can browse websites and execute commands for the user.",
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
    functions: [
      {
        name: "execute_playwright",
        description: "Execute browser automation",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
            url: { type: "string" },
            selector: { type: "string" },
          },
        },
      },
    ],
  });

  console.log(response.choices[0].message);
}
*/

// Example 3: Simple command parsing (without LLM)
/*
async function handleViberMessageWithCommands(
  userId: string,
  message: string
) {
  const commands: Record<string, (args: string[]) => Promise<string>> = {
    browse: async (args: string[]) => {
      const url = args[0];
      // await executor.execute({ action: "navigate", url });
      return `Browsing ${url}`;
    },
    click: async (args: string[]) => {
      const selector = args[0];
      // await executor.execute({ action: "click", selector });
      return `Clicked ${selector}`;
    },
    type: async (args: string[]) => {
      const text = args.join(" ");
      // await executor.execute({ action: "type", text });
      return `Typed: ${text}`;
    },
    screenshot: async (_args: string[]) => {
      // const path = await executor.execute({ action: "screenshot" });
      return "Screenshot taken";
    },
  };

  const parts = message.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (command in commands) {
    const result = await commands[command](args);
    // await sendMessage(userId, result);
  } else {
    // await sendMessage(userId, "Unknown command. Try: browse, click, type, screenshot");
  }
}
*/

// Example 4: Stateful conversation tracking
/*
interface ConversationState {
  userId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  currentTask?: {
    name: string;
    params: Record<string, unknown>;
  };
}

const activeConversations = new Map<string, ConversationState>();

async function trackConversation(userId: string, userMessage: string) {
  let state = activeConversations.get(userId) || {
    userId,
    messages: [],
    currentTask: undefined,
  };

  state.messages.push({ role: "user", content: userMessage });

  // Determine if user wants to execute a task
  if (userMessage.includes("browse")) {
    const url = userMessage.match(/browse\s+(\S+)/)?.[1] || "";
    state.currentTask = {
      name: "browse",
      params: { url },
    };
  }

  activeConversations.set(userId, state);

  return state;
}
*/

// Example 5: Advanced: Conversation with context and tool chaining
/*
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}

async function intelligentResponseWithChaining(
  userId: string,
  userMessage: string
) {
  // 1. Get conversation history
  const history =
    conversationHistory.get(userId) || [
      {
        role: "assistant",
        content: "I'm your helpful Viber bot. What can I do for you?",
      },
    ];

  // 2. Send to Claude with conversation context
  // const response = await claudeWithTools([...history, { role: "user", content: userMessage }]);

  // 3. Execute any tools Claude requests
  // 4. Send response back to user
  // 5. Store in history

  return history;
}
*/

export {};
