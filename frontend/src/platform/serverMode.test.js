import assert from "node:assert/strict";
import test from "node:test";

import {
  initialDesktopMode,
  serverFailure,
  statusMatchesOrigin,
  validServerAddress,
} from "./serverMode.js";

test("accepts only a plain HTTPS origin", () => {
  assert.equal(validServerAddress("https://vault.example"), true);
  assert.equal(validServerAddress(" HTTPS://vault.example:8443 "), true);
  for (const value of [
    "http://vault.example",
    "https://user@vault.example",
    "https://vault.example/path",
    "https://vault.example/?next=other",
    "https://vault.example/#entry",
    "https://vault.example\\other",
    "https://vault.example\n",
  ]) {
    assert.equal(validServerAddress(value), false, value);
  }
});

test("restores first-run, local, closed-server, and selected-server modes", () => {
  assert.deepEqual(initialDesktopMode({ selected: false, origin: null }), {
    screen: "choose",
    autoConnect: false,
  });
  assert.deepEqual(initialDesktopMode({ selected: true, origin: null }), {
    screen: "local",
    autoConnect: false,
  });
  assert.deepEqual(initialDesktopMode({ selected: false, origin: "https://one.example/" }), {
    screen: "server",
    autoConnect: false,
  });
  assert.deepEqual(initialDesktopMode({ selected: true, origin: "https://one.example/" }), {
    screen: "server",
    autoConnect: true,
  });
  assert.deepEqual(initialDesktopMode({ selected: true, origin: "https://one.example/" }, true), {
    screen: "choose",
    autoConnect: false,
  });
});

test("rejects stale or malformed status from another origin", () => {
  assert.equal(statusMatchesOrigin("https://one.example/path", "https://one.example"), true);
  assert.equal(statusMatchesOrigin("https://two.example/", "https://one.example"), false);
  assert.equal(statusMatchesOrigin("not a URL", "https://one.example"), false);
  assert.equal(statusMatchesOrigin(undefined, "https://one.example"), true);
});

test("maps the private WebView2 gate separately from ordinary connection failures", () => {
  assert.equal(serverFailure("Update Microsoft Edge WebView2"), "webviewUnavailable");
  assert.equal(serverFailure("offline"), "serverFailed");
});
