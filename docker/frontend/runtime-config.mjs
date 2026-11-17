import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const API_URL_PLACEHOLDER = "__NEDRA_API_URL__";
export const DEFAULT_API_URL = "http://localhost:8000/api";
export const DEFAULT_GITHUB_REPO = "WEBzaytsev/Nedra";

const RELATIVE_PATH = /^(?!\/\/)[A-Za-z0-9._~\-/]+$/;
const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const UNSAFE = /[\s'";,<>\\`{}|^*]/;

export class ConfigError extends Error {}

const ANY_HTTP_HOST = ["http:", "https:"];

export const parseApiUrl = (value) => {
  const raw = (value ?? "").trim() || DEFAULT_API_URL;
  if (RELATIVE_PATH.test(raw)) {
    return { url: raw, sources: [], warnings: [] };
  }
  if (UNSAFE.test(raw)) {
    throw new ConfigError(`the API URL contains characters a URL may not: ${raw}`);
  }
  const protocolRelative = raw.startsWith("//");
  let url;
  try {
    url = new URL(protocolRelative ? `http:${raw}` : raw);
  } catch {
    throw new ConfigError(`the API URL is not a valid URL or path: ${raw}`);
  }
  if (!ANY_HTTP_HOST.includes(url.protocol)) {
    throw new ConfigError(`the API URL must use http or https: ${raw}`);
  }
  const warnings = [];
  if (url.username || url.password) {
    warnings.push(
      "the API URL contains a user name or password, which anyone who opens the UI can read"
    );
  }
  if (url.search || url.hash) {
    warnings.push("the API URL contains a query or fragment, which request paths will follow");
  }
  if (url.hostname.startsWith("[")) {
    warnings.push(
      "CSP cannot name an IPv6 address, so the UI may connect to any host over " +
        "http or https; use a host name for the API URL to restrict it"
    );
    return { url: raw, sources: protocolRelative ? ANY_HTTP_HOST : [url.protocol], warnings };
  }
  if (protocolRelative) {
    const authority = raw.slice(2).split("/")[0];
    return { url: raw, sources: [authority.slice(authority.lastIndexOf("@") + 1).toLowerCase()], warnings };
  }
  return { url: raw, sources: [url.origin], warnings };
};

export const parseGithubRepo = (value) => {
  const repo = (value ?? "").trim() || DEFAULT_GITHUB_REPO;
  if (!GITHUB_REPO.test(repo)) {
    throw new ConfigError(`NEDRA_GITHUB_REPO must look like owner/name: ${repo}`);
  }
  return repo;
};

export const connectSources = ({ apiSources, githubRepo }) => [
  "'self'",
  ...apiSources,
  `https://api.github.com/repos/${githubRepo}/releases/latest`,
];

export const withConnectSrc = (policy, sources) => {
  const directives = policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^connect-src(\s|$)/i.test(part));
  directives.push(`connect-src ${sources.join(" ")}`);
  return directives.join("; ");
};

export const renderServeConfig = (config, sources) => ({
  ...config,
  headers: config.headers.map((rule) => ({
    ...rule,
    headers: rule.headers.map((header) =>
      header.key.toLowerCase() === "content-security-policy"
        ? { ...header, value: withConnectSrc(header.value, sources) }
        : header
    ),
  })),
});

const scriptsIn = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return scriptsIn(path);
    return path.endsWith(".js") ? [path] : [];
  });

export const injectApiUrl = (distDir, apiUrl) => {
  for (const path of scriptsIn(distDir)) {
    const text = readFileSync(path, "utf8");
    if (text.includes(API_URL_PLACEHOLDER)) {
      writeFileSync(path, text.split(API_URL_PLACEHOLDER).join(apiUrl));
    }
  }
};

export const configure = ({ env, distDir, serveConfig, output, log }) => {
  const api = parseApiUrl(env.VITE_API_URL);
  const githubRepo = parseGithubRepo(env.NEDRA_GITHUB_REPO);
  for (const warning of api.warnings) log(`Warning: ${warning}`);
  const sources = connectSources({ apiSources: api.sources, githubRepo });
  injectApiUrl(distDir, api.url);
  const config = JSON.parse(readFileSync(serveConfig, "utf8"));
  writeFileSync(output, JSON.stringify(renderServeConfig(config, sources), null, 2));
  log(`API URL: ${api.url}`);
  log(`connect-src ${sources.join(" ")}`);
};

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const ERROR_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const writeErrorSite = (dir, configPath, message) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Nedra cannot start</title></head>
<body>
<h1>Nedra cannot start</h1>
<p>The web UI is not served because ${escapeHtml(message)}.</p>
<p>Set NEDRA_API_URL in your .env (VITE_API_URL in the frontend container) to the address
browsers use to reach the API, such as https://vault.example.com/api or /api, then run
<code>docker compose -f docker-compose.prod.yml up -d</code>. Your vault is not affected.</p>
</body>
</html>
`
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      headers: [
        {
          source: "**/*",
          headers: [
            { key: "Content-Security-Policy", value: ERROR_POLICY },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Cache-Control", value: "no-store" },
          ],
        },
      ],
    })
  );
};

export const CONFIG_ERROR_EXIT = 3;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [distDir, serveConfig, output, errorDir, errorConfig] = process.argv.slice(2);
  try {
    configure({ env: process.env, distDir, serveConfig, output, log: console.log });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`Nedra cannot start: ${error.message}`);
    writeErrorSite(errorDir, errorConfig, error.message);
    process.exit(CONFIG_ERROR_EXIT);
  }
}
