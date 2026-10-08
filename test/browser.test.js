import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrowserSession, browserArguments } from "../lib/browser.js";

test("manual sign-in uses ordinary Chrome without debugging or automation flags", () => {
  const args = browserArguments("C:/Pagepress/profile", {
    url: "https://drive.google.com/drive/my-drive",
  });
  assert.ok(args.includes("--user-data-dir=C:/Pagepress/profile"));
  assert.ok(args.includes("https://drive.google.com/drive/my-drive"));
  assert.ok(
    args.every(
      (argument) => !/debugging|automation|disable-blink/i.test(argument),
    ),
  );
  assert.ok(
    browserArguments("C:/Pagepress/profile", { capture: true }).includes(
      "--remote-debugging-port=0",
    ),
  );
});

test("sign-in never attaches Playwright and capture waits for the sign-in window to close", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pagepress-signin-"));
  const session = new BrowserSession(folder);
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const launches = [];
  let closed = false;
  session.close = async () => {
    closed = true;
  };
  session.attach = async () => {
    assert.fail("Sign-in must not attach a debugger");
  };
  session.launch = async (options) => {
    assert.ok(closed);
    launches.push(options);
    return child;
  };
  try {
    await session.openAccount();
    await session.openAccount();
    assert.equal(launches.length, 1);
    assert.equal(launches[0].capture, false);
    assert.equal(session.state, "signin");
    await assert.rejects(session.connect(), /close the Pagepress sign-in/);
    child.exitCode = 0;
    child.emit("exit", 0);
    assert.equal(session.signingIn, false);
    const context = { label: "capture context" };
    session.open = async () => context;
    assert.equal(await session.connect(), context);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("capture browser closes through Chrome before disconnecting, without force killing it", async () => {
  const session = new BrowserSession("unused");
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => assert.fail("Chrome must be closed gracefully");
  const calls = [];
  session.process = child;
  session.browser = {
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (command) => {
        calls.push(command);
        child.exitCode = 0;
        child.emit("exit", 0);
      },
    }),
    close: async () => calls.push("disconnect"),
  };
  await session.close();
  assert.deepEqual(calls, ["Browser.close", "disconnect"]);
  assert.equal(session.process, null);
});
