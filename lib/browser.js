import { chromium } from "playwright";
import { access, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "Google/Chrome/Application/chrome.exe",
      ),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    "Chrome was not found. Install Chrome, set CHROME_PATH, or run npx playwright install chromium.",
  );
}

export function browserArguments(
  profilePath,
  { capture = false, url = "about:blank" } = {},
) {
  return [
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=en-US",
    "--window-size=1400,1000",
    "--disable-background-mode",
    ...(capture
      ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]
      : []),
    url,
  ];
}

export class BrowserSession extends EventEmitter {
  constructor(profilePath) {
    super();
    this.profilePath = profilePath;
    this.browser = null;
    this.opening = null;
    this.process = null;
    this.signInProcess = null;
    this.accountOpening = null;
  }

  get connected() {
    return Boolean(this.browser?.isConnected());
  }
  get signingIn() {
    return Boolean(
      this.signInProcess &&
      this.signInProcess.exitCode === null &&
      this.signInProcess.signalCode == null,
    );
  }
  get state() {
    return this.signingIn || this.accountOpening
      ? "signin"
      : this.connected
        ? "connected"
        : "closed";
  }

  async connect() {
    if (this.signingIn || this.accountOpening) {
      throw new Error(
        "Finish signing in and close the Pagepress sign-in Chrome window. Capture will resume automatically.",
      );
    }
    if (this.connected) return this.browser.contexts()[0];
    if (!this.opening)
      this.opening = this.open().finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  async launch(options) {
    const executable = await findBrowser();
    const child = spawn(
      executable,
      browserArguments(this.profilePath, options),
      { stdio: "ignore", windowsHide: false },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) =>
        reject(new Error(`Could not open Chrome: ${error.message}`)),
      );
    });
    return child;
  }

  async attach() {
    const data = await readFile(
      path.join(this.profilePath, "DevToolsActivePort"),
      "utf8",
    );
    const [port, endpoint] = data.trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(port) || !endpoint.startsWith("/devtools/browser/"))
      throw new Error("Browser is starting.");
    const browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${port}${endpoint}`,
      { timeout: 1500 },
    );
    this.browser = browser;
    browser.on("disconnected", () => {
      if (this.browser === browser) {
        this.browser = null;
        this.emit("change");
      }
    });
    this.emit("change");
    return browser.contexts()[0];
  }

  async open() {
    await mkdir(this.profilePath, { recursive: true });
    try {
      return await this.attach();
    } catch {}
    this.process = await this.launch({ capture: true });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return await this.attach();
      } catch {}
      await delay(300);
    }
    throw new Error(
      "Chrome did not connect. Close all Pagepress sign-in Chrome windows, then retry the capture.",
    );
  }

  async openAccount() {
    if (this.signingIn) return;
    if (!this.accountOpening) {
      this.accountOpening = this.openSignIn().finally(() => {
        this.accountOpening = null;
        this.emit("change");
      });
    }
    return this.accountOpening;
  }

  async openSignIn() {
    await this.close();
    await mkdir(this.profilePath, { recursive: true });
    const child = await this.launch({
      capture: false,
      url: "https://drive.google.com/drive/my-drive",
    });
    this.signInProcess = child;
    child.once("exit", () => {
      if (this.signInProcess === child) {
        this.signInProcess = null;
        this.emit("change");
      }
    });
    this.emit("change");
  }

  async close() {
    if (this.opening) await this.opening.catch(() => {});
    const browser = this.browser;
    const child = this.process;
    if (this.connected) {
      const protocol = await browser.newBrowserCDPSession();
      await protocol.send("Browser.close").catch((error) => {
        if (!/closed|disconnected/i.test(error.message)) throw error;
      });
    }
    if (child && child.exitCode === null && child.signalCode == null) {
      await new Promise((resolve, reject) => {
        const onExit = () => {
          clearTimeout(deadline);
          resolve();
        };
        const deadline = setTimeout(() => {
          child.removeListener("exit", onExit);
          reject(
            new Error(
              "Close the Pagepress capture Chrome window normally before signing in.",
            ),
          );
        }, 10000);
        child.once("exit", onExit);
        if (child.exitCode !== null || child.signalCode != null) onExit();
      });
    }
    await browser?.close().catch(() => {});
    this.browser = null;
    this.process = null;
    this.emit("change");
  }
}

export async function sampleBrowser() {
  return chromium.launch({
    executablePath: await findBrowser(),
    headless: true,
  });
}
