import test from "node:test";
import assert from "node:assert/strict";
import { parseDriveLink, selectPages, outputName } from "../lib/input.js";

const fileId = "1PagepressSampleFileId1234567890";

test("normalizes Drive viewer links without account-specific parameters", () => {
  assert.deepEqual(
    parseDriveLink(
      ` https://drive.google.com/file/d/${fileId}/view?usp=sharing `,
    ),
    {
      id: fileId,
      url: `https://drive.google.com/file/d/${fileId}/view`,
    },
  );
});

test("preserves resource keys on shared links", () => {
  assert.equal(
    parseDriveLink(
      `https://drive.google.com/open?id=${fileId}&resourcekey=0-test_key`,
    ).url,
    `https://drive.google.com/file/d/${fileId}/view?resourcekey=0-test_key`,
  );
});

test("rejects folders, untrusted hosts, credentials and arbitrary paths", () => {
  for (const url of [
    "http://127.0.0.1/secret",
    `https://drive.google.com.attacker.test/file/d/${fileId}/view`,
    `https://user@drive.google.com/file/d/${fileId}/view`,
    "https://drive.google.com/drive/u/1/folders/abcdef",
    `https://drive.google.com/search?id=${fileId}`,
    "not a link",
  ]) {
    assert.throws(() => parseDriveLink(url));
  }
});

test("every document page is included in ascending order", () => {
  assert.deepEqual(selectPages(1), [1]);
  assert.deepEqual(selectPages(3), [1, 2, 3]);
  assert.equal(selectPages(500).length, 500);
  assert.equal(selectPages(500).at(-1), 500);
});

test("invalid or oversized documents fail rather than produce partial PDFs", () => {
  for (const total of [0, -1, 1.5, NaN, Infinity, "3"]) {
    assert.throws(() => selectPages(total));
  }
  assert.throws(() => selectPages(501), /No partial PDF/);
  assert.throws(() => selectPages(999999999), /No partial PDF/);
});

test("output names cannot escape the output directory", () => {
  assert.equal(
    outputName("Web AdminPortal.pdf"),
    "Web AdminPortal (page capture).pdf",
  );
  assert.ok(!/[<>:"/\\|?*]/.test(outputName("../bad:file.pdf")));
  assert.equal(outputName("CON.pdf"), "Drive document (page capture).pdf");
});
