import express, { Express, Request, Response } from "express";
import { ViberBotAPI } from "./viber.js";
import { handleViberMessage } from "./index.js";

export function createWebhookServer(
  viberBot: ViberBotAPI,
  port: number = 3001
): Express {
  const app = express();

  app.use(express.json());

  // Health check endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Viber webhook endpoint
  app.post("/webhook/viber", (req: Request, res: Response) => {
    const payload = req.body;

    // Immediately acknowledge the webhook
    res.status(200).json({ status: "ok" });

    // Parse and handle the message
    const message = viberBot.parseWebhookPayload(payload);

    if (message && message.type === "message" && message.message) {
      handleViberMessage(message.userId, message.message).catch((error) => {
        console.error("Error handling message:", error);
      });
    }

    return undefined;
  });

  // Set webhook endpoint
  app.post("/webhook/set", async (req: Request, res: Response): Promise<void> => {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      res.status(400).json({ error: "webhookUrl is required" });
      return;
    }

    const success = await viberBot.setWebhook(webhookUrl);

    if (success) {
      res.json({ status: "ok", message: "Webhook set successfully" });
    } else {
      res.status(500).json({ error: "Failed to set webhook" });
    }
  });

  app.listen(port, () => {
    console.log(
      `Viber webhook server listening on port ${port}`
    );
  });

  return app;
}
