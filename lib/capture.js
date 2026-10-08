import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { selectPages, outputName } from "./input.js";

export const PAGE_SELECTOR =
  ".ndfHFb-c4YZDc-cYSp0e-DARUcf, [data-pagepress-page]";

export async function capturePdf({
  page,
  url,
  outputDir,
  quality = "standard",
  onUpdate = async () => {},
  waitForUser,
  signal = new AbortController().signal,
}) {
  const check = () => signal.throwIfAborted();
  check();
  await onUpdate({
    status: "opening",
    message: "Opening document",
    progress: 2,
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.bringToFront();
  let ready = false;
  let signInAttempts = 0;
  while (!ready) {
    check();
    const snapshot = await page.evaluate(
      (selector) => ({
        count: document.querySelectorAll(selector).length,
        text: (document.body?.innerText || "").slice(0, 5000),
        host: location.hostname,
      }),
      PAGE_SELECTOR,
    );
    if (
      /you need access|you don't have access|request access|file does not exist|unable to open the file/i.test(
        snapshot.text,
      )
    ) {
      throw new Error(
        "This account cannot view the file. Ask the owner for access or switch accounts in the capture browser.",
      );
    }
    if (snapshot.host === "accounts.google.com") {
      if (!waitForUser) throw new Error("Google sign-in is required.");
      signInAttempts += 1;
      if (signInAttempts > 2)
        throw new Error(
          "Google still requires sign-in. Finish signing in in normal Chrome, close its window, then retry this capture.",
        );
      await onUpdate({
        status: "waiting",
        message: "Google sign-in required; opening a normal Chrome window",
      });
      const resumedPage = await waitForUser();
      if (resumedPage) page = resumedPage;
      check();
      await onUpdate({
        status: "opening",
        message: "Checking document access",
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.bringToFront();
      continue;
    }
    try {
      await page.waitForFunction(
        (selector) => {
          const label =
            document
              .querySelector('input[aria-label^="Page "][aria-label*=" of "]')
              ?.getAttribute("aria-label") ||
            document.querySelector('[role="main"] h2')?.textContent ||
            "";
          const total = Number(label.match(/of\s+(\d+)/i)?.[1]);
          return (
            total > 0 && document.querySelectorAll(selector).length === total
          );
        },
        PAGE_SELECTOR,
        { timeout: 25000, polling: 250 },
      );
      ready = true;
    } catch {
      if (new URL(page.url()).hostname === "accounts.google.com") continue;
      check();
      throw new Error(
        "The complete PDF page count could not be verified. Check that the document has loaded in the capture browser, then retry.",
      );
    }
  }
  const info = await page.evaluate((selector) => {
    const containers = [...document.querySelectorAll(selector)];
    const label =
      document
        .querySelector('input[aria-label^="Page "][aria-label*=" of "]')
        ?.getAttribute("aria-label") ||
      document.querySelector('[role="main"] h2')?.textContent ||
      "";
    const total = Number(label.match(/of\s+(\d+)/i)?.[1]);
    return {
      title: document.title.replace(/\s*-\s*Google Drive\s*$/, ""),
      total,
      containers: containers.length,
    };
  }, PAGE_SELECTOR);
  if (info.total !== info.containers)
    throw new Error(
      "The page count could not be verified. Reload the viewer and retry.",
    );
  const selected = selectPages(info.total);
  const targetWidth = quality === "high" ? 3200 : 1600;
  const zoom = page.getByRole("combobox", {
    name: "Page zoom control",
    exact: true,
  });
  if (await zoom.count()) {
    await zoom.fill(quality === "high" ? "200%" : "100%");
    await zoom.press("Enter");
  }
  await mkdir(outputDir, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${info.title.replace(/\.pdf$/i, "")} - page capture`);
  pdf.setCreator("Pagepress");
  pdf.setSubject("Image-based capture of authorized document pages");
  let imageBytes = 0;
  const warnings = [];
  await onUpdate({
    title: info.title,
    total: selected.length,
    sourcePages: info.total,
    status: "capturing",
    message: "Capturing pages",
    completed: 0,
    progress: 5,
  });
  for (const [index, number] of selected.entries()) {
    check();
    await onUpdate({
      pageNumber: number,
      message: `Rendering page ${number} of ${info.total}`,
    });
    await page.evaluate(
      ({ selector, number }) => {
        const container = document.querySelectorAll(selector)[number - 1];
        if (!container) throw new Error(`Page ${number} is missing.`);
        container.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
      },
      { selector: PAGE_SELECTOR, number },
    );
    const imageReady = ({ selector, number, width }) => {
      const container = document.querySelectorAll(selector)[number - 1];
      const image = container?.querySelector("img");
      const heading = container?.querySelector("h2")?.textContent || "";
      return (
        image?.complete &&
        image.naturalWidth >= width &&
        (!heading || new RegExp(`^Page ${number} of `).test(heading.trim()))
      );
    };
    try {
      await page.waitForFunction(
        imageReady,
        { selector: PAGE_SELECTOR, number, width: targetWidth },
        { timeout: 15000, polling: 200 },
      );
    } catch {
      check();
      await page.waitForFunction(
        imageReady,
        { selector: PAGE_SELECTOR, number, width: 500 },
        { timeout: 15000, polling: 200 },
      );
      if (!warnings.length)
        warnings.push(
          "Some pages were available below the requested resolution.",
        );
    }
    const pixels = await page.evaluate(
      ({ selector, number }) => {
        const image = document
          .querySelectorAll(selector)
          [number - 1].querySelector("img");
        if (image.naturalWidth * image.naturalHeight > 60000000)
          throw new Error("Page is too large. Retry at standard resolution.");
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        const data = canvas.toDataURL("image/png");
        if (!data.startsWith("data:image/png;base64,"))
          throw new Error("Page pixels could not be captured.");
        return {
          data: data.split(",")[1],
          width: canvas.width,
          height: canvas.height,
        };
      },
      { selector: PAGE_SELECTOR, number },
    );
    const buffer = Buffer.from(pixels.data, "base64");
    imageBytes += buffer.length;
    if (imageBytes > 200 * 1024 * 1024)
      throw new Error(
        "This document exceeds the 200 MB capture limit. Try standard resolution or a smaller document. No partial PDF will be saved.",
      );
    check();
    const image = await pdf.embedPng(buffer);
    const scale = Math.min(720 / image.width, 14400 / image.height);
    const sheet = pdf.addPage([image.width * scale, image.height * scale]);
    sheet.drawImage(image, {
      x: 0,
      y: 0,
      width: sheet.getWidth(),
      height: sheet.getHeight(),
    });
    if (index === 0)
      await writeFile(path.join(outputDir, "preview.png"), buffer);
    await onUpdate({
      completed: index + 1,
      pageNumber: number,
      progress: 5 + Math.round(((index + 1) / selected.length) * 90),
      preview: true,
      width: pixels.width,
      height: pixels.height,
      warnings,
    });
  }
  check();
  await onUpdate({
    status: "assembling",
    message: "Assembling PDF",
    progress: 97,
  });
  const bytes = await pdf.save();
  const verified = await PDFDocument.load(bytes);
  if (verified.getPageCount() !== selected.length)
    throw new Error("PDF page-count verification failed.");
  check();
  const temporary = path.join(outputDir, "document.partial");
  await writeFile(temporary, bytes);
  check();
  await rename(temporary, path.join(outputDir, "document.pdf"));
  return {
    title: info.title,
    filename: outputName(info.title),
    pages: selected.length,
    size: bytes.length,
    warnings,
  };
}
