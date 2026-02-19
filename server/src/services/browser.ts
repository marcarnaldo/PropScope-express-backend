/**
 * Browser Manager
 *
 * Manages a headless Chromium instance via Puppeteer with stealth plugin
 * to bypass Cloudflare protection on SIA. Handles initialization, health checks,
 * and automatic recovery if the browser becomes unresponsive.
 */

import { Page, Browser } from "puppeteer";
import puppeteer from "puppeteer-extra";
import { getErrorMessage, MAX_RETRIES } from "../utils/errorHandling";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { logger } from "../utils/errorHandling";

puppeteer.use(StealthPlugin());

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private lastUrl: string | null = null;

  constructor() {}

  /** Launches a headless browser and navigates to the given URL to establish session/cookies. */
  public async initializeBrowser(url: string): Promise<void> {
    this.lastUrl = url;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info(
          { attempt, maxRetries: MAX_RETRIES },
          "Attempting to launch browser",
        );

        this.browser = await puppeteer.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"], // To make sure chrome run in production server environments
        });

        this.page = await this.browser.newPage();

        await this.page.goto(url, {
          waitUntil: "domcontentloaded", // We wait for the html to fully load to set the cookies, allow us to query, etc
          timeout: 30000, // We wait 30s for the page to respond. If not, we retry
        });

        logger.info("Browser initialized successfully");
        return;
      } catch (error) {
        lastError = error;

        const errorMessage = getErrorMessage(error);

        // Clean and close the browser instance since we will retry
        await this.closeBrowser();

        if (attempt === MAX_RETRIES) break;
        // Exponential backoff
        const waitTime = Math.pow(2, attempt) * 1000;

        logger.warn(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            error: errorMessage,
            waitMs: waitTime,
          },
          "failed to initialize a browser, retrying",
        );

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to initialize browser after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /** Closes the browser and cleans up page/browser references. */
  public async closeBrowser(): Promise<void> {
    if (!this.browser) return;

    // Close and clean the browser instance even if it throws an error
    await this.browser.close().catch(() => {});
    this.browser = null;
    this.page = null;
  }

  /** Returns the active page. Throws if browser hasn't been initialized. */
  public getPage(): Page {
    if (!this.page) {
      throw new Error(
        "Browser not initialized. Call initializeBrowser() first.",
      );
    }
    return this.page;
  }

  /** Checks if the browser and page are still responsive by running a small script. */
  public async isHealthy(): Promise<boolean> {
    // return false is there is no page or browser yet
    if (!this.browser || !this.page) return false;

    try {
      // Run a small script in the page to confirm the browser and tab are still responsive
      await this.page.evaluate(() => true);
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Checks browser health and automatically recovers by relaunching if unresponsive. */
  public async ensureHealthy(): Promise<void> {
    const healthy = await this.isHealthy();

    if (!healthy) {
      if (!this.lastUrl) {
        throw new Error("Cannot recover: No URL stored.");
      }
      logger.warn("Browser unhealthy, attempting recovery...");
      await this.closeBrowser();
      await this.initializeBrowser(this.lastUrl);
      logger.info("Browser recovery successful");
    } else {
      // Browser is alive but session might be stale, refresh it if so
      await this.page!.goto(this.lastUrl!, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
  }
}
