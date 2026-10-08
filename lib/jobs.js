import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import { BrowserSession, sampleBrowser } from "./browser.js";
import { capturePdf } from "./capture.js";
import { InputError, parseDriveLink } from "./input.js";

const FINAL = new Set(["complete", "failed", "cancelled", "interrupted"]);

export class JobManager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.jobs = [];
    this.session = new BrowserSession(path.join(dataDir, "browser-profile"));
    this.active = null;
    this.running = null;
    this.resumeCurrent = null;
    this.stopping = false;
    this.origin = "";
    this.writes = Promise.resolve();
    this.session.on("change", () => {
      if (this.session.state !== "signin" && !this.stopping)
        this.resumeCurrent?.();
      this.emit("change", this.snapshot());
      this.kick();
    });
  }

  folder(id) {
    return path.join(this.dataDir, "jobs", id);
  }

  async init() {
    const root = path.join(this.dataDir, "jobs");
    await mkdir(root, { recursive: true });
    for (const name of await readdir(root)) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      try {
        const job = JSON.parse(
          await readFile(path.join(root, name, "state.json"), "utf8"),
        );
        if (job.id !== name) continue;
        if (job.status !== "complete") delete job.range;
        if (["queued", "waiting", "opening"].includes(job.status)) {
          job.status = "queued";
          job.message = "Queued for capture";
        } else if (!FINAL.has(job.status)) {
          job.status = "interrupted";
          job.message = "The app restarted before this capture finished.";
        }
        if (job.status === "complete") {
          try {
            await access(path.join(root, name, "document.pdf"));
          } catch {
            job.status = "failed";
            job.message = "The saved PDF was removed from disk.";
          }
        }
        this.jobs.push(job);
      } catch {}
    }
    this.jobs.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  snapshot() {
    return { jobs: this.jobs, browser: this.session.state };
  }

  async save(job, changes = {}) {
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    const content = JSON.stringify(job, null, 2);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.folder(job.id), { recursive: true });
        await writeFile(path.join(this.folder(job.id), "state.json"), content);
      });
    await this.writes;
    this.emit("change", this.snapshot());
  }

  find(id) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new InputError("Capture not found.");
    return job;
  }

  async create(input) {
    if (this.stopping) throw new InputError("The app is shutting down.");
    if (input.permission !== true && input.sample !== true)
      throw new InputError(
        "Confirm that you have permission to save these files.",
      );
    if (!["standard", "high"].includes(input.quality || "standard"))
      throw new InputError("Choose standard or high resolution.");
    const links =
      input.sample === true
        ? [{ id: "sample", url: null }]
        : (Array.isArray(input.links) ? input.links : []).map(parseDriveLink);
    if (links.length < 1 || links.length > 10)
      throw new InputError("Enter between 1 and 10 Drive PDF links.");
    if (this.jobs.length + links.length > 100)
      throw new InputError(
        "Delete older captures before adding more. The library limit is 100.",
      );
    const created = [];
    for (const link of links) {
      const job = {
        id: randomUUID(),
        kind: input.sample === true ? "sample" : "drive",
        sourceUrl: link.url,
        fileId: link.id,
        title: input.sample === true ? "Field Notes.pdf" : "Google Drive PDF",
        quality: input.quality || "standard",
        permission: true,
        status: "queued",
        message: "Queued",
        createdAt: new Date().toISOString(),
        total: 0,
        completed: 0,
        progress: 0,
        preview: false,
      };
      this.jobs.unshift(job);
      await this.save(job);
      created.push(job);
    }
    this.kick();
    return created;
  }

  kick() {
    if (this.running || this.stopping) return;
    const job = [...this.jobs]
      .reverse()
      .find(
        (candidate) =>
          candidate.status === "queued" &&
          (candidate.kind === "sample" || this.session.state !== "signin"),
      );
    if (!job) return;
    this.running = this.run(job)
      .catch((error) => {
        console.error("Capture storage error:", error.message);
      })
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  async run(job) {
    const controller = new AbortController();
    this.active = { id: job.id, controller, page: null };
    let browser;
    try {
      await this.save(job, {
        status: "opening",
        message: "Opening capture browser",
      });
      let page;
      if (job.kind === "sample") {
        browser = await sampleBrowser();
        page = await browser.newPage({
          viewport: { width: 1400, height: 1000 },
        });
      } else {
        if (this.session.state === "signin")
          await this.waitForSignIn(job, controller, false);
        const context = await this.session.connect();
        page = await context.newPage();
        await page.setViewportSize({ width: 1400, height: 1000 });
      }
      this.active.page = page;
      controller.signal.throwIfAborted();
      const result = await capturePdf({
        page,
        url:
          job.kind === "sample"
            ? `${this.origin}/sample-viewer.html`
            : job.sourceUrl,
        outputDir: this.folder(job.id),
        quality: job.quality,
        signal: controller.signal,
        onUpdate: async (changes) => {
          controller.signal.throwIfAborted();
          await this.save(job, changes);
        },
        waitForUser: async () => {
          await this.active.page?.close().catch(() => {});
          this.active.page = null;
          await this.waitForSignIn(job, controller);
          controller.signal.throwIfAborted();
          const context = await this.session.connect();
          const resumedPage = await context.newPage();
          this.active.page = resumedPage;
          await resumedPage.setViewportSize({ width: 1400, height: 1000 });
          controller.signal.throwIfAborted();
          return resumedPage;
        },
      });
      controller.signal.throwIfAborted();
      await this.save(job, {
        ...result,
        status: "complete",
        message: "Ready to download",
        progress: 100,
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      let message = cancelled
        ? "Capture cancelled"
        : (error.message || "Capture failed").split("\n")[0].slice(0, 350);
      if (!cancelled && /closed|disconnected/i.test(message))
        message = "The capture browser was closed. Retry to open it again.";
      await this.save(job, {
        status: cancelled ? "cancelled" : "failed",
        message,
      });
    } finally {
      await this.active?.page?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await rm(path.join(this.folder(job.id), "document.partial"), {
        force: true,
      });
      if (job.status !== "complete")
        await rm(path.join(this.folder(job.id), "document.pdf"), {
          force: true,
        });
      this.resumeCurrent = null;
      this.active = null;
      this.emit("change", this.snapshot());
    }
  }

  async waitForSignIn(job, controller, openWindow = true) {
    controller.signal.throwIfAborted();
    if (openWindow) await this.session.openAccount();
    controller.signal.throwIfAborted();
    let abort;
    const waiting = new Promise((resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      this.resumeCurrent = resolve;
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      else if (this.session.state !== "signin") resolve();
    });
    try {
      await Promise.all([
        waiting,
        this.save(job, {
          status: "waiting",
          message:
            "Sign in in Chrome, then close that sign-in window. Capture will resume automatically.",
        }),
      ]);
    } finally {
      this.resumeCurrent = null;
      controller.signal.removeEventListener("abort", abort);
    }
  }

  async cancel(id) {
    const job = this.find(id);
    if (FINAL.has(job.status)) return;
    if (this.active?.id === id) {
      this.active.controller.abort(new Error("Capture cancelled"));
      await this.active.page?.close().catch(() => {});
    }
    await this.save(job, { status: "cancelled", message: "Capture cancelled" });
    this.kick();
  }

  resume(id) {
    if (this.active?.id !== id || !this.resumeCurrent)
      throw new InputError("This capture is not waiting for sign-in.");
    if (this.session.state === "signin")
      throw new InputError(
        "Finish signing in and close the Pagepress sign-in Chrome window first, then click Continue.",
      );
    this.resumeCurrent();
  }

  async retry(id) {
    const job = this.find(id);
    if (!FINAL.has(job.status) || job.status === "complete")
      throw new InputError("Only stopped captures can be retried.");
    return this.create({
      links: [job.sourceUrl],
      sample: job.kind === "sample",
      quality: job.quality,
      permission: true,
    });
  }

  async delete(id) {
    const job = this.find(id);
    if (!FINAL.has(job.status) || this.active?.id === id)
      throw new InputError("Cancel the active capture before deleting it.");
    await this.writes;
    await rm(this.folder(id), { recursive: true, force: true });
    this.jobs = this.jobs.filter((candidate) => candidate.id !== id);
    this.emit("change", this.snapshot());
  }

  async shutdown() {
    this.stopping = true;
    if (this.active) await this.cancel(this.active.id);
    await this.running;
    await this.session.close();
  }
}
