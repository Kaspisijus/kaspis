import { chromium, Browser, Page } from "playwright";
import { execSync } from "child_process";

interface PlaywrightAction {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  delay?: number;
}

interface PlaywrightResult {
  success: boolean;
  result?: string | Record<string, unknown>;
  error?: string;
}

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async initBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch();
    }
    if (!this.page) {
      this.page = await this.browser.newPage();
    }
  }

  async execute(action: PlaywrightAction): Promise<PlaywrightResult> {
    await this.initBrowser();

    if (!this.page) {
      return { success: false, error: "Failed to initialize browser" };
    }

    try {
      switch (action.action) {
        case "navigate": {
          if (!action.url) {
            return { success: false, error: "URL is required for navigate" };
          }
          await this.page.goto(action.url);
          return {
            success: true,
            result: `Navigated to ${action.url}`,
          };
        }

        case "click": {
          if (!action.selector) {
            return {
              success: false,
              error: "Selector is required for click",
            };
          }
          await this.page.click(action.selector);
          return {
            success: true,
            result: `Clicked on ${action.selector}`,
          };
        }

        case "type": {
          if (!action.selector || !action.text) {
            return {
              success: false,
              error: "Selector and text are required for type",
            };
          }
          await this.page.fill(action.selector, action.text);
          return {
            success: true,
            result: `Typed in ${action.selector}`,
          };
        }

        case "screenshot": {
          const screenshotPath = `/tmp/screenshot-${Date.now()}.png`;
          await this.page.screenshot({ path: screenshotPath });
          return {
            success: true,
            result: screenshotPath,
          };
        }

        case "get_title": {
          const title = await this.page.title();
          return {
            success: true,
            result: title,
          };
        }

        case "wait": {
          if (!action.delay) {
            return {
              success: false,
              error: "Delay is required for wait",
            };
          }
          await this.page.waitForTimeout(action.delay);
          return {
            success: true,
            result: `Waited ${action.delay}ms`,
          };
        }

        default:
          return {
            success: false,
            error: `Unknown action: ${action.action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async executeSystemCommand(
    command: string,
    args?: string[]
  ): Promise<string> {
    try {
      // This is a basic implementation. In production, you should use a safer
      // approach like child_process.spawn() with proper validation.
      const fullCommand = args ? `${command} ${args.join(" ")}` : command;
      const result = execSync(fullCommand, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return result;
    } catch (error) {
      throw new Error(
        `Command execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async close() {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Execute multiple Playwright actions in sequence
   */
  async executeSequence(actions: PlaywrightAction[]): Promise<PlaywrightResult[]> {
    const results: PlaywrightResult[] = [];

    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);

      if (!result.success) {
        // Stop on first error
        break;
      }
    }

    return results;
  }

  /**
   * Get current page content as HTML
   */
  async getPageContent(): Promise<string | undefined> {
    if (!this.page) {
      throw new Error("Browser not initialized");
    }
    return this.page.content();
  }

  /**
   * Extract text from page
   */
  async getPageText(): Promise<string | undefined> {
    if (!this.page) {
      throw new Error("Browser not initialized");
    }
    return this.page.evaluate(() => document.body.innerText);
  }

  /**
   * Wait for selector to be visible
   */
  async waitForSelector(
    selector: string,
    timeout: number = 5000
  ): Promise<boolean> {
    if (!this.page) {
      throw new Error("Browser not initialized");
    }
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }
}
