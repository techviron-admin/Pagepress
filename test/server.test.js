import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../server.js";
import { sampleBrowser } from "../lib/browser.js";

function waitForJob(manager, id, status) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off("change", changed);
      const pending = manager.jobs
        .map(
          (job) =>
            `${job.status}: ${job.completed}/${job.total} (${job.message})`,
        )
        .join("; ");
      reject(new Error(`Job did not reach ${status}. Queue: ${pending}`));
    }, 30000);
    const changed = () => {
      const job = manager.find(id);
      if (job.status === "failed") {
        clearTimeout(timeout);
        manager.off("change", changed);
        reject(new Error(job.message));
      } else if (
        job.status === status &&
        (status !== "waiting" || manager.resumeCurrent)
      ) {
        clearTimeout(timeout);
        manager.off("change", changed);
        resolve(job);
      }
    };
    manager.on("change", changed);
    changed();
  });
}

test(
  "queue drains automatically after sign-in and skips a cancelled queued capture",
  { timeout: 60000 },
  async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "pagepress-queue-"));
    const { manager } = await createApplication({ dataDir });
    const browser = await sampleBrowser();
    const context = await browser.newContext();
    const html = await readFile(
      new URL("../public/sample-viewer.html", import.meta.url),
      "utf8",
    );
    await context.route("https://drive.google.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await context.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" }),
    );
    const newPage = context.newPage.bind(context);
    let opening = 0;
    context.newPage = async () => {
      const page = await newPage();
      opening += 1;
      if (opening === 1) {
        const navigate = page.goto.bind(page);
        page.goto = () =>
          navigate("https://accounts.google.com/signin", {
            waitUntil: "domcontentloaded",
          });
      }
      return page;
    };
    manager.session.connect = async () => context;
    manager.session.close = async () => {};
    manager.session.openAccount = async () => {
      manager.session.signInProcess = { exitCode: null, signalCode: null };
    };
    try {
      const [first] = await manager.create({
        links: ["https://drive.google.com/file/d/12345678901/view"],
        permission: true,
      });
      await waitForJob(manager, first.id, "waiting");
      const [cancelled, next] = await manager.create({
        links: [
          "https://drive.google.com/file/d/12345678902/view",
          "https://drive.google.com/file/d/12345678903/view",
        ],
        permission: true,
      });
      assert.equal(next.status, "queued");
      await manager.cancel(cancelled.id);
      const complete = waitForJob(manager, next.id, "complete");
      manager.session.signInProcess = null;
      manager.session.emit("change");
      await complete;
      assert.equal(first.status, "complete");
      assert.equal(first.pages, 3);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(next.pages, 3);
      assert.equal(opening, 3);
      const reopened = await createApplication({ dataDir });
      assert.equal(reopened.manager.find(first.id).status, "complete");
    } finally {
      manager.session.signInProcess = null;
      await manager.shutdown();
      await browser.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("pending jobs stay queued after a restart instead of needing manual retries", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pagepress-restart-"));
  const { manager } = await createApplication({ dataDir });
  manager.kick = () => {};
  try {
    const [queued, waiting] = await manager.create({
      links: [
        "https://drive.google.com/file/d/12345678901/view",
        "https://drive.google.com/file/d/12345678902/view",
      ],
      permission: true,
    });
    await manager.save(waiting, { status: "waiting", range: "1" });
    const reopened = await createApplication({ dataDir });
    assert.equal(reopened.manager.find(queued.id).status, "queued");
    assert.equal(reopened.manager.find(waiting.id).status, "queued");
    assert.equal(
      Object.hasOwn(reopened.manager.find(waiting.id), "range"),
      false,
    );
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("new jobs and retries discard old page-selection settings", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pagepress-all-pages-"));
  const { manager } = await createApplication({ dataDir });
  manager.kick = () => {};
  try {
    const [job] = await manager.create({
      links: ["https://drive.google.com/file/d/12345678901/view"],
      range: "1",
      permission: true,
    });
    assert.equal(Object.hasOwn(job, "range"), false);
    await manager.save(job, { status: "failed", range: "1" });
    const [retried] = await manager.retry(job.id);
    assert.equal(Object.hasOwn(retried, "range"), false);
    const persisted = JSON.parse(
      await readFile(
        path.join(manager.folder(retried.id), "state.json"),
        "utf8",
      ),
    );
    assert.equal(Object.hasOwn(persisted, "range"), false);
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("closing sign-in automatically resumes the waiting job and cancellation remains available", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pagepress-auth-"));
  const { manager } = await createApplication({ dataDir });
  manager.kick = () => {};
  manager.session.openAccount = async () => {
    manager.session.signInProcess = { exitCode: null, signalCode: null };
  };
  try {
    const [job] = await manager.create({
      links: ["https://drive.google.com/file/d/12345678901/view"],
      permission: true,
    });
    const controller = new AbortController();
    manager.active = { id: job.id, controller, page: null };
    const changed = once(manager, "change");
    const waiting = manager.waitForSignIn(job, controller);
    await changed;
    assert.equal(manager.snapshot().browser, "signin");
    assert.equal(job.status, "waiting");
    assert.throws(() => manager.resume(job.id), /close the Pagepress sign-in/);
    manager.session.signInProcess = null;
    manager.session.emit("change");
    await waiting;
    assert.equal(manager.resumeCurrent, null);

    const nextChange = once(manager, "change");
    const cancelled = assert.rejects(
      manager.waitForSignIn(job, controller),
      /Capture cancelled/,
    );
    await nextChange;
    await manager.cancel(job.id);
    await cancelled;
    assert.equal(job.status, "cancelled");
    assert.equal(manager.resumeCurrent, null);
  } finally {
    manager.active = null;
    manager.session.signInProcess = null;
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local API rejects cross-site writes, validates consent, and persists cancelled jobs", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pagepress-api-"));
  const { app, manager, token } = await createApplication({ dataDir });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  manager.origin = origin;
  manager.kick = () => {};
  const headers = {
    "Content-Type": "application/json",
    "X-Pagepress-Token": token,
  };
  const post = (body, custom = headers) =>
    fetch(`${origin}/api/jobs`, {
      method: "POST",
      headers: custom,
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post({ sample: true }, { "Content-Type": "application/json" }))
        .status,
      403,
    );
    assert.equal(
      (
        await post(
          { sample: true },
          { ...headers, Origin: "https://example.com" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post({
          links: ["https://drive.google.com/file/d/12345678901/view"],
        })
      ).status,
      400,
    );
    assert.equal(
      (await post({ links: ["http://127.0.0.1/secret"], permission: true }))
        .status,
      400,
    );
    const response = await post({ sample: true, quality: "high", range: "1" });
    assert.equal(response.status, 201);
    const {
      jobs: [job],
    } = await response.json();
    assert.equal(Object.hasOwn(job, "range"), false);
    assert.equal(
      (await fetch(`${origin}/api/jobs/${job.id}/download`)).status,
      409,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/jobs/${job.id}/cancel`, {
          method: "POST",
          headers,
        })
      ).status,
      200,
    );
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.jobs[0].status, "cancelled");
    const reopened = await createApplication({ dataDir });
    assert.equal(reopened.manager.jobs[0].status, "cancelled");
    assert.equal(
      (
        await fetch(`${origin}/api/jobs/${job.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(manager.jobs.length, 0);
  } finally {
    await manager.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
