import express from "express";
import { randomBytes, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager } from "./lib/jobs.js";
import { InputError } from "./lib/input.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DATA =
  process.env.PAGEPRESS_DATA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "Pagepress",
    createHash("sha256").update(ROOT).digest("hex").slice(0, 12),
  );

export async function createApplication({ dataDir = LOCAL_DATA } = {}) {
  const manager = new JobManager(dataDir);
  await manager.init();
  const token = randomBytes(24).toString("hex");
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    let host;
    try {
      host = new URL(`http://${request.headers.host}`).hostname;
    } catch {}
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
      return response.status(403).json({ error: "Local requests only." });
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.path !== "/sample-viewer.html") {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    if (request.path.startsWith("/api/")) {
      response.setHeader("Cache-Control", "no-store");
      const origin = request.headers.origin;
      if (
        (origin && origin !== `http://${request.headers.host}`) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        return response
          .status(403)
          .json({ error: "Cross-site requests are not allowed." });
      }
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers["x-pagepress-token"] !== token
      ) {
        return response
          .status(403)
          .json({ error: "Refresh Pagepress to reconnect securely." });
      }
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/state", (request, response) =>
    response.json({ ...manager.snapshot(), token }),
  );
  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const send = (state) =>
      response.write(`data: ${JSON.stringify(state)}\n\n`);
    send(manager.snapshot());
    manager.on("change", send);
    const heartbeat = setInterval(
      () => response.write(": heartbeat\n\n"),
      20000,
    );
    response.on("close", () => {
      clearInterval(heartbeat);
      manager.off("change", send);
    });
  });
  app.post("/api/jobs", async (request, response) =>
    response
      .status(201)
      .json({ jobs: await manager.create(request.body || {}) }),
  );
  app.post("/api/jobs/:id/cancel", async (request, response) => {
    await manager.cancel(request.params.id);
    response.json({ ok: true });
  });
  app.post("/api/jobs/:id/continue", (request, response) => {
    manager.resume(request.params.id);
    response.json({ ok: true });
  });
  app.post("/api/jobs/:id/retry", async (request, response) =>
    response.status(201).json({ jobs: await manager.retry(request.params.id) }),
  );
  app.delete("/api/jobs/:id", async (request, response) => {
    await manager.delete(request.params.id);
    response.json({ ok: true });
  });
  app.get("/api/jobs/:id/preview", (request, response) => {
    const job = manager.find(request.params.id);
    if (!job.preview) return response.sendStatus(404);
    response.sendFile(path.join(manager.folder(job.id), "preview.png"));
  });
  app.get("/api/jobs/:id/download", (request, response) => {
    const job = manager.find(request.params.id);
    if (job.status !== "complete")
      return response.status(409).json({ error: "This PDF is not ready yet." });
    response.download(
      path.join(manager.folder(job.id), "document.pdf"),
      job.filename,
    );
  });
  app.post("/api/browser/open", async (request, response) => {
    if (
      manager.active?.page &&
      manager.find(manager.active.id).kind === "drive"
    )
      await manager.active.page.bringToFront();
    else await manager.session.openAccount();
    manager.emit("change", manager.snapshot());
    response.json({ ok: true });
  });
  app.post("/api/browser/close", async (request, response) => {
    if (manager.session.state === "signin")
      throw new InputError(
        "Close the sign-in Chrome window normally to save your session.",
      );
    if (manager.active?.id && manager.find(manager.active.id).kind === "drive")
      throw new InputError(
        "Cancel the active capture before closing its browser.",
      );
    await manager.session.close();
    manager.emit("change", manager.snapshot());
    response.json({ ok: true });
  });
  app.use(
    "/vendor/icons",
    express.static(path.join(ROOT, "node_modules/lucide/dist/umd"), {
      index: false,
    }),
  );
  app.use(
    "/fonts/manrope",
    express.static(path.join(ROOT, "node_modules/@fontsource/manrope/files"), {
      index: false,
    }),
  );
  app.use(
    "/fonts/mono",
    express.static(
      path.join(ROOT, "node_modules/@fontsource/ibm-plex-mono/files"),
      { index: false },
    ),
  );
  app.use(express.static(path.join(ROOT, "public")));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error instanceof InputError ? 400 : error.status || 500;
    response
      .status(status)
      .json({
        error:
          status === 500
            ? error.message || "Unexpected local error."
            : error.message,
      });
  });
  return { app, manager, token };
}

async function main() {
  const application = await createApplication();
  const requested = Number(process.env.PORT || 4310);
  if (!Number.isInteger(requested) || requested < 1024 || requested > 65520)
    throw new Error("PORT must be between 1024 and 65520.");
  let server;
  for (let port = requested; port < requested + 10; port += 1) {
    try {
      server = await new Promise((resolve, reject) => {
        const listener = application.app.listen(port, "127.0.0.1", () =>
          resolve(listener),
        );
        listener.once("error", reject);
      });
      application.manager.origin = `http://127.0.0.1:${port}`;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  if (!server) throw new Error("No free port found. Set PORT to another port.");
  console.log(`Pagepress is ready at ${application.manager.origin}`);
  console.log(`Private local data: ${LOCAL_DATA}`);
  application.manager.kick();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await application.manager.shutdown();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
