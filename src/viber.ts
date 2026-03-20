import axios, { AxiosInstance } from "axios";

interface ViberMessage {
  type: string;
  text: string;
  keyboard?: Record<string, unknown>;
}

interface ViberUser {
  id: string;
  name: string;
  avatar?: string;
}

export class ViberBotAPI {
  private apiClient: AxiosInstance;

  constructor(apiToken: string, webhookUrl?: string) {
    this.apiClient = axios.create({
      baseURL: "https://chatapi.viber.com/pa",
      headers: {
        "X-Viber-Auth-Token": apiToken,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Send a text message to a user
   */
  async sendMessage(
    userId: string,
    message: string,
    keyboard?: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const payload: ViberMessage = {
        type: "text",
        text: message,
      };

      if (keyboard) {
        payload.keyboard = keyboard;
      }

      await this.apiClient.post(`/send_message`, {
        receiver: userId,
        ...payload,
      });

      return true;
    } catch (error) {
      console.error(
        `Failed to send message to ${userId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Send a rich media message (image, video, etc.)
   */
  async sendRichMedia(
    userId: string,
    mediaType: "picture" | "video" | "file",
    mediaUrl: string,
    mediaSize: number
  ): Promise<boolean> {
    try {
      await this.apiClient.post(`/send_message`, {
        receiver: userId,
        type: mediaType,
        media: mediaUrl,
        size: mediaSize,
      });

      return true;
    } catch (error) {
      console.error(
        `Failed to send ${mediaType} to ${userId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Get user information
   */
  async getUserInfo(userId: string): Promise<ViberUser | null> {
    try {
      const response = await this.apiClient.get(
        `/get_user_details?viber_user_ids=${userId}`
      );

      if (response.data.users && response.data.users.length > 0) {
        const user = response.data.users[0];
        return {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
        };
      }

      return null;
    } catch (error) {
      console.error(
        `Failed to get user info for ${userId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Set webhook for receiving messages
   */
  async setWebhook(webhookUrl: string): Promise<boolean> {
    try {
      const response = await this.apiClient.post(`/set_webhook`, {
        url: webhookUrl,
        send_name: true,
        send_photo: true,
        event_types: [
          "delivered",
          "seen",
          "failed",
          "subscribed",
          "unsubscribed",
          "conversation_started",
        ],
      });

      if (response.data.status === 0) {
        return true;
      }

      return false;
    } catch (error) {
      console.error(
        `Failed to set webhook:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo(): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.apiClient.get(`/get_account_info`);
      return response.data;
    } catch (error) {
      console.error(
        `Failed to get account info:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Parse webhook payload
   */
  parseWebhookPayload(payload: Record<string, unknown>): {
    type: string;
    userId: string;
    message?: string;
    event?: string;
  } | null {
    try {
      if (payload.event === "message") {
        return {
          type: "message",
          userId: (payload.sender as Record<string, unknown>)?.id as string,
          message: (payload.message as Record<string, unknown>)?.text as string,
        };
      }

      if (payload.event === "conversation_started") {
        return {
          type: "conversation_started",
          userId: (payload.user as Record<string, unknown>)?.id as string,
        };
      }

      if (
        payload.event === "subscribed" ||
        payload.event === "unsubscribed"
      ) {
        return {
          type: payload.event as string,
          userId: (payload.user as Record<string, unknown>)?.id as string,
          event: payload.event as string,
        };
      }

      return null;
    } catch (error) {
      console.error(
        `Failed to parse webhook:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }
}
