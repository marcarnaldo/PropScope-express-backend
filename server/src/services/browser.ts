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
import proxyChain from "proxy-chain";
import crypto from "crypto";

puppeteer.use(StealthPlugin());

const POOL_SIZE = 3;

const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
  "texttrack",
  "eventsource",
  "manifest",
  "other",
]);

const generateSessionId = (): string => crypto.randomBytes(4).toString("hex");

/**
 * Builds the IPRoyal proxy password with a fresh session ID.
 * Takes the base password (everything before _session-) and appends a new session.
 *
 * Example:
 *   base: S8AzxIWTu6FxZirE_country-ca_city-vancouver
 *   result: S8AzxIWTu6FxZirE_country-ca_city-vancouver_session-a1b2c3d4_lifetime-24h
 */
const buildProxyPassword = (): string => {
  const basePassword = process.env.PROXY_PASSWORD_BASE;
  const lifetime = process.env.PROXY_LIFETIME || "24h";
  const sessionId = generateSessionId();
  return `${basePassword}_session-${sessionId}_lifetime-${lifetime}`;
};

export class BrowserManager {
  private browser: Browser | null = null;
  private lastUrl: string | null = null;
  private idlePages: Page[] = [];
  private activePages: Set<Page> = new Set();
  private currentSessionId: string | null = null;

  constructor() {}

  /** Launches a headless browser and navigates to the given URL to establish session/cookies. */
  public async initializeBrowser(url: string): Promise<void> {
    this.lastUrl = url;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Generate a fresh session ID for each attempt so we get a new IP
        const proxyPassword = buildProxyPassword();
        this.currentSessionId =
          proxyPassword.match(/_session-([^_]+)/)?.[1] || null;

        logger.info(
          {
            attempt,
            maxRetries: MAX_RETRIES,
            sessionId: this.currentSessionId,
          },
          "Attempting to launch browser with fresh proxy session",
        );

        // Build the full proxy URL with the fresh session
        const oldProxyUrl = `http://${process.env.PROXY_USERNAME}:${proxyPassword}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
        // Spins up a local proxy on a random port that forwards to IPRoyal
        const newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
        // Launch with the local proxy
        this.browser = await puppeteer.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            `--proxy-server=${newProxyUrl}`,
          ],
        });

        // Create a tab at initialization
        const setupPage = await this.browser.newPage();
        await this.enableResourceBlocking(setupPage);
        await setupPage.goto(url, {
          waitUntil: "domcontentloaded", // We wait for the html to fully load to set the cookies, allow us to query, etc
          timeout: 30000, // We wait 30s for the page to respond. If not, we retry
        });

        const pageTitle = await setupPage.title();
        const pageUrl = setupPage.url();
        logger.info(
          { pageTitle, pageUrl, sessionId: this.currentSessionId },
          "Browser initialized successfully",
        );

        // close the setupPage since we are done setting up
        await setupPage.close();
        // Create a pool of idle pages at initialization
        await this.createPagePool();
        return;
      } catch (error) {
        lastError = error;

        const errorMessage = getErrorMessage(error);

        // Clean and close the browser instance since we will retry with a new session
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
            sessionId: this.currentSessionId,
          },
          "Failed to initialize browser, rotating proxy session and retrying",
        );

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw new Error(
      `Failed to initialize browser after ${MAX_RETRIES} attempts: ${lastError}`,
    );
  }

  /** Block any unnecessary resource except XHR where the api lives */
  private async enableResourceBlocking(page: Page) {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        request.abort();
      } else {
        request.continue();
      }
    });
  }

  /** Create a pool of pages and push it to idlePages */
  private async createPagePool(): Promise<void> {
    if (!this.browser) throw new Error("Browser not initialized");

    for (let i = 0; i < POOL_SIZE; i++) {
      const page = await this.browser.newPage();
      await this.enableResourceBlocking(page);
      // Navigate to SIA so the page has the correct origin and cookies for fetch()
      await page.goto("https://www.sportsinteraction.com/favicon.ico", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      this.idlePages.push(page);
    }
    logger.info({ poolSize: POOL_SIZE }, "Page pool created");
  }

  /** Get a page from the pool of idlePages. If no page is present in idlePages, keep waiting until one is available to use. */
  public async acquirePage(): Promise<Page> {
    // We return a page if there is a page available in our pool
    if (this.idlePages.length > 0) {
      const page = this.idlePages.pop()!;
      this.activePages.add(page);
      return page;
    }

    logger.warn(
      { active: this.activePages.size, idle: this.idlePages.length },
      "No idle pages available, waiting",
    );

    // Check the pool of pages every 100ms until there is an available page to return
    // The promise will only settle once it is resolved
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.idlePages.length > 0) {
          clearInterval(interval);
          const page = this.idlePages.pop()!;
          this.activePages.add(page);
          resolve(page);
        }
      }, 100);
    });
  }
  /** Release the page from activePages and puts in back in idlePages */
  public releasePage(page: Page): void {
    // Put the page back to idlePages once done so others can use it
    this.activePages.delete(page);
    this.idlePages.push(page);
  }

  /** Closes the browser and cleans up page/browser references. */
  public async closeBrowser(): Promise<void> {
    if (!this.browser) return;
    await this.browser.close().catch(() => {});
    this.browser = null;
    this.idlePages = [];
    this.activePages.clear();
  }

  /** Checks if the browser and page are still responsive by running a small script. */
  public async isHealthy(): Promise<boolean> {
    if (!this.browser) return false;
    try {
      const testPage = await this.browser.newPage();
      await testPage.close();
      return true;
    } catch (error) {
      return false;
    }
  }
}
