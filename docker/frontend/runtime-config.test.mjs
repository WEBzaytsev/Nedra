import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  ERROR_POLICY,
  configure,
  connectSources,
  parseApiUrl,
  parseGithubRepo,
  withConnectSrc,
  writeErrorSite,
} from "./runtime-config.mjs";

const RELEASES = "https://api.github.com/repos/WEBzaytsev/Nedra/releases/latest";
const SERVE_JSON = new URL("../../frontend/serve.json", import.meta.url);

test("absolute API URLs allow exactly their origin", () => {
  for (const [url, origin] of [
    ["http://localhost:8000/api", "http://localhost:8000"],
    ["https://vault.example.com/api", "https://vault.example.com"],
    ["https://vault.example.com:443/api/", "https://vault.example.com"],
    ["http://192.168.1.20:8000/api", "http://192.168.1.20:8000"],
    ["https://API.Example.COM:8443/nedra/api", "https://api.example.com:8443"],
    ["http://vault_backend:8000/api", "http://vault_backend:8000"],
  ]) {
    assert.deepEqual(parseApiUrl(url), { url, sources: [origin], warnings: [] });
  }
});

test("relative API paths, with or without a leading slash, use the UI's own origin", () => {
  for (const url of ["/api", "api", "nedra/api/", "/"]) {
    assert.deepEqual(parseApiUrl(url), { url, sources: [], warnings: [] });
  }
  assert.deepEqual(connectSources({ apiSources: [], githubRepo: "WEBzaytsev/Nedra" }), [
    "'self'",
    RELEASES,
  ]);
});

test("protocol-relative API URLs allow that host on the page's own scheme", () => {
  assert.deepEqual(parseApiUrl("//Vault.Example.com:8443/api").sources, [
    "vault.example.com:8443",
  ]);
  assert.deepEqual(parseApiUrl("//user:secret@vault.example.com/api").sources, [
    "vault.example.com",
  ]);
});

test("values v1.4.7 accepted keep working, with a warning", () => {
  const credentials = parseApiUrl("https://user:secret@vault.example.com/api");
  assert.deepEqual(credentials.sources, ["https://vault.example.com"]);
  assert.match(credentials.warnings[0], /user name or password/);
  assert.match(parseApiUrl("https://vault.example.com/api?x=1").warnings[0], /query/);
  assert.match(parseApiUrl("https://vault.example.com/api#x").warnings[0], /query/);
});

test("an unset API URL keeps the documented default", () => {
  assert.deepEqual(parseApiUrl(undefined).sources, ["http://localhost:8000"]);
  assert.deepEqual(parseApiUrl("  ").sources, ["http://localhost:8000"]);
});

test("an IPv6 API host falls back to its scheme, with a warning", () => {
  const api = parseApiUrl("http://[::1]:8000/api");
  assert.deepEqual(api.sources, ["http:"]);
  assert.match(api.warnings[0], /IPv6/);
  assert.deepEqual(parseApiUrl("//[::1]:8000/api").sources, ["http:", "https:"]);
});

test("unsafe or unusable API URLs are refused", () => {
  for (const url of [
    "javascript:alert(1)",
    "ftp://vault.example.com/api",
    "localhost:8000/api",
    "http://vault.example.com/api'; script-src *",
    "http://vault.example.com/api\"",
    "http://vault.example.com/api;connect-src *",
    "http://vault.example.com/a b",
    "//*/api",
    "http://*.example.com/api",
    "http://",
  ]) {
    assert.throws(() => parseApiUrl(url), ConfigError, url);
  }
});

test("the GitHub repository must be owner/name", () => {
  assert.equal(parseGithubRepo(undefined), "WEBzaytsev/Nedra");
  assert.equal(parseGithubRepo("someone/fork.of-user"), "someone/fork.of-user");
  for (const repo of ["mr-grj", "a/b/c", "a/b releases", "*/*", "a/b;x"]) {
    assert.throws(() => parseGithubRepo(repo), ConfigError, repo);
  }
});

test("only connect-src is replaced and nothing else in the policy changes", () => {
  const policy = JSON.parse(readFileSync(SERVE_JSON, "utf8")).headers[0].headers.find(
    (header) => header.key === "Content-Security-Policy"
  ).value;
  assert.match(policy, /connect-src 'self';/);
  assert.doesNotMatch(policy, /connect-src \*/);
  const rendered = withConnectSrc(policy, ["'self'", "http://localhost:8000", RELEASES]);
  const directives = Object.fromEntries(
    rendered.split("; ").map((part) => [part.split(" ")[0], part])
  );
  assert.equal(directives["connect-src"], `connect-src 'self' http://localhost:8000 ${RELEASES}`);
  assert.equal(directives["script-src"], "script-src 'self'");
  assert.equal(directives["default-src"], "default-src 'self'");
  assert.equal(rendered.match(/connect-src/g).length, 1);
  assert.doesNotMatch(rendered, /\*/);
});

test("configure injects the API URL and writes the rendered serve.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "nedra-runtime-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  const bundle = join(dir, "dist", "assets", "index.js");
  writeFileSync(bundle, 'const a="__NEDRA_API_URL__";const b="__NEDRA_API_URL__";');
  const output = join(dir, "serve.json");
  const logs = [];

  configure({
    env: { VITE_API_URL: "https://vault.example.com/api" },
    distDir: join(dir, "dist"),
    serveConfig: SERVE_JSON,
    output,
    log: (line) => logs.push(line),
  });

  assert.equal(
    readFileSync(bundle, "utf8"),
    'const a="https://vault.example.com/api";const b="https://vault.example.com/api";'
  );
  const csp = JSON.parse(readFileSync(output, "utf8")).headers[0].headers.find(
    (header) => header.key === "Content-Security-Policy"
  ).value;
  assert.match(csp, /connect-src 'self' https:\/\/vault\.example\.com https:\/\/api\.github\.com/);
  assert.ok(logs.some((line) => line.startsWith("connect-src")));
});

test("configure refuses before touching the bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "nedra-runtime-"));
  mkdirSync(join(dir, "dist"));
  const bundle = join(dir, "dist", "index.js");
  writeFileSync(bundle, 'const a="__NEDRA_API_URL__";');
  assert.throws(
    () =>
      configure({
        env: { VITE_API_URL: "http://x/api'; script-src *" },
        distDir: join(dir, "dist"),
        serveConfig: SERVE_JSON,
        output: join(dir, "serve.json"),
        log: () => {},
      }),
    ConfigError
  );
  assert.equal(readFileSync(bundle, "utf8"), 'const a="__NEDRA_API_URL__";');
});

test("the error page explains the problem without serving the app", () => {
  const dir = mkdtempSync(join(tmpdir(), "nedra-runtime-"));
  const site = join(dir, "site");
  const config = join(dir, "error.json");
  writeErrorSite(site, config, `the API URL is not valid: <script>alert("x")</script>`);
  const html = readFileSync(join(site, "index.html"), "utf8");
  assert.match(html, /Nedra cannot start/);
  assert.match(html, /NEDRA_API_URL/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&#60;script&#62;/);
  const headers = JSON.parse(readFileSync(config, "utf8")).headers[0].headers;
  assert.equal(headers.find((h) => h.key === "Content-Security-Policy").value, ERROR_POLICY);
  assert.equal(headers.find((h) => h.key === "Cache-Control").value, "no-store");
});
