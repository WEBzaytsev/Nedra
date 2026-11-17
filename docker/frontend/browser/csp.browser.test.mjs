import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { chromium } from "playwright";

import { startFrontend, stopFrontend } from "./frontend.mjs";
const RELEASES = "https://api.github.com/repos/WEBzaytsev/Nedra/releases/latest";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const fakeApi = (seen) => (request, response) => {
  seen.push(request.url);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") {
    response.end();
  } else if (request.url.endsWith("/auth/status")) {
    response.end(JSON.stringify({ initialized: true }));
  } else {
    response.end(JSON.stringify({ version: "test", features: [] }));
  }
};

const attempt = (page, action, target) =>
  page.evaluate(
    async ({ action, target }) => {
      const violations = [];
      const record = (event) => violations.push(event.blockedURI);
      document.addEventListener("securitypolicyviolation", record);
      let outcome;
      try {
        if (action === "fetch") {
          outcome = (await fetch(target)).status;
        } else if (action === "beacon") {
          outcome = navigator.sendBeacon(target, "token");
        } else if (action === "xhr") {
          const request = new XMLHttpRequest();
          request.open("GET", target);
          request.send();
          outcome = "sent";
        } else if (action === "websocket") {
          new WebSocket(target);
          outcome = "opened";
        } else if (action === "image") {
          new Image().src = target;
          outcome = "set";
        }
      } catch (error) {
        outcome = `error: ${error.message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      document.removeEventListener("securitypolicyviolation", record);
      return { outcome, violations };
    },
    { action, target }
  );

let browser;
let api;
let elsewhere;
const apiSeen = [];
const elsewhereSeen = [];

before(async () => {
  browser = await chromium.launch();
  api = await listen(fakeApi(apiSeen));
  elsewhere = await listen(fakeApi(elsewhereSeen));
});

after(async () => {
  await browser?.close();
  api?.close();
  elsewhere?.close();
});

describe("API on another origin", () => {
  let frontend;
  let apiOrigin;
  let otherOrigin;

  before(async () => {
    apiOrigin = `http://127.0.0.1:${api.address().port}`;
    otherOrigin = `http://127.0.0.1:${elsewhere.address().port}`;
    frontend = await startFrontend(`${apiOrigin}/api`);
  });

  after(() => stopFrontend(frontend));

  test("the policy names exactly the API origin and the release check", async () => {
    const response = await fetch(frontend.url);
    const csp = response.headers.get("content-security-policy");
    const connect = csp.split("; ").find((part) => part.startsWith("connect-src"));
    assert.equal(connect, `connect-src 'self' ${apiOrigin} ${RELEASES}`);
    assert.doesNotMatch(csp, /\*/);
  });

  test("the app reaches its API with no policy violation", async () => {
    const page = await browser.newPage();
    const violations = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    apiSeen.length = 0;
    await page.goto(frontend.url);
    await page.getByRole("button", { name: "Unlock Vault" }).waitFor();
    assert.ok(apiSeen.includes("/api/auth/status"), apiSeen.join());
    assert.deepEqual(violations, []);

    const allowed = await attempt(page, "fetch", `${apiOrigin}/api/meta`);
    assert.equal(allowed.outcome, 200);
    assert.deepEqual(allowed.violations, []);
    await page.close();
  });

  test("connections anywhere else are blocked before they leave the browser", async () => {
    const page = await browser.newPage();
    await page.goto(frontend.url);
    elsewhereSeen.length = 0;
    const other = `127.0.0.1:${elsewhere.address().port}`;
    const attempts = [
      ["fetch", `http://${other}/steal?t=1`],
      ["beacon", `http://${other}/beacon`],
      ["xhr", `http://${other}/xhr`],
      ["websocket", `ws://${other}/ws`],
      ["image", `http://${other}/pixel.png`],
      ["fetch", "https://api.github.com/gists"],
      ["fetch", "https://api.github.com/repos/someone/else/releases/latest"],
    ];
    for (const [action, target] of attempts) {
      const result = await attempt(page, action, target);
      assert.ok(result.violations.length > 0, `${action} ${target} was not blocked`);
    }
    assert.deepEqual(elsewhereSeen, []);
    await page.close();
  });

  test("the release check stays allowed", async () => {
    const page = await browser.newPage();
    await page.goto(frontend.url);
    const result = await attempt(page, "fetch", RELEASES);
    assert.deepEqual(result.violations, []);
    await page.close();
  });
});

describe("API behind the same origin", () => {
  let frontend;

  before(async () => {
    frontend = await startFrontend("/api");
  });

  after(() => stopFrontend(frontend));

  test("only the UI's own origin and the release check are allowed", async () => {
    const response = await fetch(frontend.url);
    const csp = response.headers.get("content-security-policy");
    const connect = csp.split("; ").find((part) => part.startsWith("connect-src"));
    assert.equal(connect, `connect-src 'self' ${RELEASES}`);

    const page = await browser.newPage();
    await page.goto(frontend.url);
    const blocked = await attempt(page, "fetch", `http://127.0.0.1:${api.address().port}/api/meta`);
    assert.ok(blocked.violations.length > 0);
    await page.close();
  });
});

describe("API on a protocol-relative URL", () => {
  let frontend;

  before(async () => {
    frontend = await startFrontend(`//127.0.0.1:${api.address().port}/api`);
  });

  after(() => stopFrontend(frontend));

  test("the page's scheme is used for the API host and other hosts stay blocked", async () => {
    const page = await browser.newPage();
    apiSeen.length = 0;
    await page.goto(frontend.url);
    await page.getByRole("button", { name: "Unlock Vault" }).waitFor();
    assert.ok(apiSeen.includes("/api/auth/status"), apiSeen.join());
    const blocked = await attempt(page, "fetch", `http://127.0.0.1:${elsewhere.address().port}/x`);
    assert.ok(blocked.violations.length > 0);
    await page.close();
  });
});

describe("unsafe configuration", () => {
  for (const apiUrl of ["http://x.test/api'; script-src *", "javascript:alert(1)"]) {
    test(`${apiUrl} serves an explanation instead of the app`, async () => {
      const frontend = await startFrontend(apiUrl);
      try {
        const response = await fetch(`${frontend.url}/passwords`);
        const html = await response.text();
        assert.match(html, /Nedra cannot start/);
        assert.match(html, /NEDRA_API_URL/);
        assert.doesNotMatch(html, /<script/);
        assert.equal(
          response.headers.get("content-security-policy"),
          "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        );
        const logs = spawnSync("docker", ["logs", frontend.name]);
        assert.match(logs.stderr.toString(), /Nedra cannot start: the API URL/);
      } finally {
        stopFrontend(frontend);
      }
    });
  }
});
