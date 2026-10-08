import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { createApplication } from "../server.js";
import { sampleBrowser } from "../lib/browser.js";

test(
  "website captures and downloads a sample PDF without layout overflow",
  { timeout: 90000 },
  async () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const temporary = await mkdtemp(path.join(os.tmpdir(), "pagepress-ui-"));
    const { app, manager } = await createApplication({ dataDir: temporary });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    manager.origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await sampleBrowser();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors = [];
      const downloads = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("download", (download) =>
        downloads.push(download.suggestedFilename()),
      );
      await page.goto(`${manager.origin}/sample-viewer.html`);
      await page.waitForFunction(
        () => document.querySelector("article img")?.naturalWidth === 1600,
      );
      const png = await page
        .locator("article img")
        .first()
        .evaluate((image) => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d").drawImage(image, 0, 0);
          return canvas.toDataURL("image/png").split(",")[1];
        });
      await mkdir(path.join(root, "public", "assets"), { recursive: true });
      await writeFile(
        path.join(root, "public", "assets", "sample-cover.png"),
        Buffer.from(png, "base64"),
      );
      await Promise.all([
        page.waitForResponse((response) =>
          response.url().endsWith("/api/state"),
        ),
        page.goto(manager.origin),
      ]);
      await page.waitForFunction(
        () =>
          document.querySelector("#preview-image").complete &&
          document.querySelector("#preview-image").naturalWidth > 0,
      );
      assert.equal(
        await page.locator('#page-range, input[name="range"]').count(),
        0,
      );
      await page.locator("#drive-links").fill("https://example.com/file.pdf");
      assert.equal(await page.locator("#capture-button").isDisabled(), true);
      await page.locator("#permission").check();
      const captureRequest = page.waitForRequest(
        (request) =>
          request.method() === "POST" && request.url().endsWith("/api/jobs"),
      );
      await page.locator("#capture-button").click();
      assert.equal(
        Object.hasOwn((await captureRequest).postDataJSON(), "range"),
        false,
      );
      await page.locator("#form-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#form-error").textContent(),
        /Only https/,
      );
      await page.locator("#clear-links").click();
      assert.equal(await page.locator("#form-error").isVisible(), false);
      const autoDownload = page.waitForEvent("download", { timeout: 45000 });
      await page.locator("#sample-button").click();
      await page.waitForFunction(
        () => document.querySelector(".job-status.complete"),
        null,
        { timeout: 45000 },
      );
      const automaticFile = await autoDownload;
      assert.equal(
        automaticFile.suggestedFilename(),
        "Field Notes (page capture).pdf",
      );
      await automaticFile.saveAs(path.join(temporary, "automatic.pdf"));
      assert.equal(
        (
          await PDFDocument.load(
            await readFile(path.join(temporary, "automatic.pdf")),
          )
        ).getPageCount(),
        3,
      );
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator("#download-main").click(),
      ]);
      const downloaded = path.join(temporary, "download.pdf");
      await download.saveAs(downloaded);
      assert.equal(
        download.suggestedFilename(),
        "Field Notes (page capture).pdf",
      );
      assert.equal(
        (await PDFDocument.load(await readFile(downloaded))).getPageCount(),
        3,
      );
      await page.locator("#expand-preview").click();
      assert.equal(await page.locator("#preview-dialog").isVisible(), true);
      await page.locator("#close-preview").click();
      manager.session.openAccount = async () => {
        manager.session.signInProcess = { exitCode: null, signalCode: null };
      };
      await page
        .getByRole("button", { name: "Sign in to Google", exact: true })
        .click();
      await page.locator("#signin-notice").waitFor({ state: "visible" });
      assert.equal(await page.locator("#open-browser").isDisabled(), true);
      assert.match(
        await page.locator("#signin-notice").textContent(),
        /close that window/,
      );
      manager.jobs[0].status = "waiting";
      manager.emit("change", manager.snapshot());
      await page
        .getByRole("button", { name: "Cancel capture", exact: true })
        .waitFor();
      assert.match(
        await page.locator('[data-action="cancel"]').textContent(),
        /Cancel/,
      );
      assert.match(
        await page.locator(".progress-label").first().textContent(),
        /resumes automatically/,
      );
      assert.equal(await page.locator('[data-action="continue"]').count(), 0);
      manager.session.signInProcess = null;
      manager.jobs[0].status = "complete";
      manager.emit("change", manager.snapshot());
      await page.locator("#signin-notice").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#open-browser").isEnabled(), true);
      Object.assign(manager.jobs[0], {
        status: "capturing",
        progress: 63,
        completed: 2,
        pageNumber: 3,
      });
      manager.emit("change", manager.snapshot());
      await page.waitForFunction(
        () =>
          document.querySelector(".progress-label strong")?.textContent ===
          "63%",
      );
      assert.match(
        await page.locator(".progress-label").first().textContent(),
        /2 of 3 pages captured/,
      );
      assert.equal(
        await page
          .locator('.job-progress [role="progressbar"]')
          .first()
          .getAttribute("aria-valuenow"),
        "63",
      );
      await page.waitForFunction(() => {
        const track = document.querySelector(".job-row .progress-track");
        return (
          track.firstElementChild.getBoundingClientRect().width >
          track.getBoundingClientRect().width * 0.6
        );
      });
      await mkdir(path.join(root, "test-results"), { recursive: true });
      for (const [name, width, height] of [
        ["active-desktop", 1440, 1000],
        ["active-mobile", 390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        assert.equal(
          await page
            .getByRole("button", { name: "Cancel capture", exact: true })
            .isVisible(),
          true,
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.screenshot({
          path: path.join(root, "test-results", `${name}.png`),
          fullPage: true,
        });
      }
      Object.assign(manager.jobs[0], {
        status: "complete",
        progress: 100,
        completed: 3,
      });
      manager.emit("change", manager.snapshot());
      await page.locator(".job-status.complete").waitFor();
      assert.equal(
        downloads.length,
        2,
        "Repeated completion events must not start duplicate downloads",
      );
      manager.session.signInProcess = { exitCode: null, signalCode: null };
      manager.session.emit("change");
      await page
        .locator("#drive-links")
        .fill("https://drive.google.com/file/d/12345678901/view");
      await page.locator("#capture-button").click();
      await page.locator(".job-status.queued").waitFor();
      assert.match(
        await page.locator(".job-status.queued").textContent(),
        /Queued #1/,
      );
      assert.match(
        await page.locator("#queue-summary").textContent(),
        /Waiting for sign-in/,
      );
      const queuedRow = page
        .locator(".job-row")
        .filter({ has: page.locator(".job-status.queued") });
      await queuedRow.getByRole("button", { name: "Cancel capture" }).click();
      await page.locator(".job-status.cancelled").waitFor();
      const cancelledRow = page
        .locator(".job-row")
        .filter({ has: page.locator(".job-status.cancelled") });
      await cancelledRow
        .getByRole("button", { name: "Delete capture" })
        .click();
      await page.locator("#confirm-delete").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".job-row").length === 1,
      );
      manager.session.signInProcess = null;
      manager.session.emit("change");
      await page
        .getByRole("button", { name: "Completed", exact: false })
        .click();
      assert.equal(await page.locator("#composer").isVisible(), false);
      await page.locator("#search").fill("no-such-document");
      assert.equal(await page.locator(".job-row").count(), 0);
      await page.locator("#search").fill("");
      await page.locator('[data-view="workspace"]').click();
      await page.locator("#toast").waitFor({ state: "hidden", timeout: 8000 });
      await mkdir(path.join(root, "test-results"), { recursive: true });
      for (const [name, width, height] of [
        ["desktop", 1440, 1000],
        ["mobile", 390, 844],
        ["small-mobile", 320, 740],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          brokenImages: [...document.images]
            .filter((image) => !image.complete || image.naturalWidth === 0)
            .map((image) => image.src),
          clippedButtons: [...document.querySelectorAll("button")]
            .filter(
              (button) =>
                button.getClientRects().length &&
                button.scrollWidth > button.clientWidth + 2,
            )
            .map((button) => button.textContent),
          previewBottom: document
            .querySelector("#preview-image")
            .getBoundingClientRect().bottom,
          captionTop: document
            .querySelector("#preview-stamp")
            .getBoundingClientRect().top,
        }));
        assert.ok(
          layout.documentWidth <= layout.width,
          `${name} horizontal overflow: ${JSON.stringify(layout)}`,
        );
        assert.deepEqual(layout.brokenImages, [], `${name} broken images`);
        assert.deepEqual(layout.clippedButtons, [], `${name} clipped buttons`);
        assert.ok(
          layout.previewBottom + 4 < layout.captionTop,
          `${name} preview/caption overlap`,
        );
        await page.screenshot({
          path: path.join(root, "test-results", `${name}.png`),
          fullPage: true,
        });
      }
      await page.locator('[data-action="delete"]').click();
      await page.locator("#confirm-delete").click();
      await page.waitForFunction(
        () => document.querySelectorAll(".job-row").length === 0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
