import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { capturePdf } from "../lib/capture.js";
import { sampleBrowser } from "../lib/browser.js";

test("waits for the declared page count instead of capturing a one-page loading placeholder", async () => {
  const html = await readFile(
    new URL("../public/sample-viewer.html", import.meta.url),
  );
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      request.url === "/ready"
        ? html
        : `<!doctype html><title>Loading.pdf - Google Drive</title>
      <main role="main"><article data-pagepress-page="1">Loading document</article></main>
      <script>setTimeout(() => location.replace('/ready'), 350);</script>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await sampleBrowser();
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "pagepress-page-count-"),
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    const progress = [];
    const result = await capturePdf({
      page,
      url: `http://127.0.0.1:${server.address().port}/loading`,
      outputDir: temporary,
      onUpdate: async (update) => {
        progress.push(update);
      },
    });
    assert.equal(result.pages, 3);
    assert.equal(result.title, "Field Notes.pdf");
    assert.deepEqual(
      progress
        .filter((update) => update.width)
        .map((update) => update.pageNumber),
      [1, 2, 3],
    );
    assert.equal(
      (
        await PDFDocument.load(
          await readFile(path.join(temporary, "document.pdf")),
        )
      ).getPageCount(),
      3,
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a rejected Google login resumes on a fresh capture page after manual sign-in", async () => {
  const html = await readFile(
    new URL("../public/sample-viewer.html", import.meta.url),
  );
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await sampleBrowser();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pagepress-resume-"));
  try {
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${server.address().port}/private-file`;
    await page.route("https://accounts.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Could not sign you in</h1><p>This browser or app may not be secure.</p>",
      }),
    );
    const navigate = page.goto.bind(page);
    page.goto = () =>
      navigate("https://accounts.google.com/v3/signin/rejected", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
    let resumed = 0;
    const result = await capturePdf({
      page,
      url,
      outputDir: temporary,
      range: "1",
      waitForUser: async () => {
        resumed += 1;
        await page.close();
        return browser.newPage({ viewport: { width: 1200, height: 900 } });
      },
    });
    assert.equal(resumed, 1);
    assert.equal(page.isClosed(), true);
    assert.equal(result.pages, 3);
    assert.equal(
      (
        await PDFDocument.load(
          await readFile(path.join(temporary, "document.pdf")),
        )
      ).getPageCount(),
      3,
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("captures every lazy-loaded page even when a legacy range is supplied", async () => {
  const html = await readFile(
    new URL("../public/sample-viewer.html", import.meta.url),
  );
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await sampleBrowser();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pagepress-test-"));
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    const progress = [];
    const result = await capturePdf({
      page,
      url: `http://127.0.0.1:${server.address().port}`,
      outputDir: temporary,
      range: "3, 1",
      quality: "high",
      onUpdate: async (update) => {
        progress.push(update);
      },
    });
    assert.equal(result.pages, 3);
    assert.equal(result.filename, "Field Notes (page capture).pdf");
    assert.deepEqual(
      progress
        .filter((update) => update.width)
        .map((update) => update.pageNumber),
      [1, 2, 3],
    );
    assert.ok(
      progress.some(
        (update) =>
          update.pageNumber === 3 &&
          !update.width &&
          update.message === "Rendering page 3 of 3",
      ),
    );
    assert.ok(
      progress
        .filter((update) => update.width)
        .every((update) => update.width === 3200),
    );
    const pdf = await PDFDocument.load(
      await readFile(path.join(temporary, "document.pdf")),
    );
    assert.equal(pdf.getPageCount(), 3);
    assert.ok(
      Math.abs(pdf.getPage(0).getHeight() / pdf.getPage(0).getWidth() - 1.415) <
        0.01,
    );
    assert.ok(
      (await readFile(path.join(temporary, "preview.png"))).length > 1000,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      capturePdf({
        page,
        url: "about:blank",
        outputDir: temporary,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
