const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):([\s\S]*)$/;
const PORT_ONLY = /^\d+(?:[/?#]|$)/;
const hasControl = (value: string): boolean =>
  [...value].some(
    (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)
  );
const ASCII_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };
export const MAX_URL_LENGTH = 2048;

export interface Origin {
  scheme: "http" | "https";
  host: string;
  port: number | null;
}

const isIpv4 = (host: string): boolean =>
  IPV4.test(host) && host.split(".").every((part) => part === "0" || !part.startsWith("0"));

const canonicalHost = (raw: string): string | null => {
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) return null;
    try {
      return new URL(`https://${raw}/`).hostname;
    } catch {
      return null;
    }
  }
  const host = raw.toLowerCase().replace(/\.+$/, "");
  if (!host || host.includes("..")) return null;
  const labels = host.split(".");
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? "")) return isIpv4(host) ? host : null;
  const ascii = [...host].every((char) => char.charCodeAt(0) < 128);
  if (ascii && !labels.some((label) => label.startsWith("xn--"))) {
    return labels.every((label) => ASCII_LABEL.test(label)) && host.length < 254 ? host : null;
  }
  let parsed: string;
  try {
    parsed = new URL(`https://${host}/`).hostname.replace(/\.+$/, "");
  } catch {
    return null;
  }
  for (const label of parsed.split(".")) {
    if (!label.startsWith("xn--")) continue;
    const decoded = decodePunycode(label.slice(4));
    if (!decoded || [...decoded].every((char) => char.charCodeAt(0) < 128)) return null;
    try {
      if (new URL(`https://${decoded}/`).hostname !== label) return null;
    } catch {
      return null;
    }
  }
  return parsed || null;
};

export const normalizeOrigin = (input: unknown): Origin | null => {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let scheme: string;
  const match = SCHEME.exec(value);
  if (match && !PORT_ONLY.test(match[2] ?? "")) {
    scheme = (match[1] ?? "").toLowerCase();
    if (!(scheme in DEFAULT_PORTS) || !(match[2] ?? "").startsWith("//")) return null;
    value = `${scheme}:${match[2]}`;
  } else {
    scheme = "https";
    value = `https://${value}`;
  }
  if (value.includes("\\") || hasControl(value)) return null;
  const rest = value.slice(scheme.length + 3);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (hasControl(authority) || authority.includes(" ")) return null;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostPort || hostPort.includes("%")) return null;
  let rawHost = hostPort;
  let rawPort = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close === -1) return null;
    rawHost = hostPort.slice(0, close + 1);
    const after = hostPort.slice(close + 1);
    if (after && !after.startsWith(":")) return null;
    rawPort = after.slice(1);
  } else if (hostPort.includes(":")) {
    const colon = hostPort.lastIndexOf(":");
    rawHost = hostPort.slice(0, colon);
    rawPort = hostPort.slice(colon + 1);
  }
  let port: number | null = null;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) return null;
    port = Number(rawPort);
    if (port > 65535) return null;
  }
  const host = canonicalHost(rawHost);
  if (host === null) return null;
  if (port === DEFAULT_PORTS[scheme]) port = null;
  return { scheme: scheme as Origin["scheme"], host, port };
};

export const originString = (origin: Origin): string =>
  `${origin.scheme}://${origin.host}${origin.port === null ? "" : `:${origin.port}`}`;

export const normalize = (input: unknown): string | null => {
  const origin = normalizeOrigin(input);
  return origin ? originString(origin) : null;
};

export const sameOrigin = (page: unknown, saved: unknown): boolean => {
  const a = normalize(page);
  return a !== null && a === normalize(saved);
};

export const displayHost = (origin: Origin): string => {
  const text = originString(origin);
  return origin.scheme === "http" ? text : text.slice("https://".length);
};

export const unicodeHost = (host: string): string | null => {
  const labels = host.split(".");
  if (!labels.some((label) => label.startsWith("xn--"))) return null;
  const decoded = labels.map((label) =>
    label.startsWith("xn--") ? decodePunycode(label.slice(4)) : label
  );
  return decoded.every((label) => label !== null) ? decoded.join(".") : null;
};

const decodePunycode = (input: string): string | null => {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const adapt = (delta: number, points: number, first: boolean): number => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + 38));
  };
  const digit = (code: number): number =>
    code - 48 < 10 ? code - 22 : code - 65 < 26 ? code - 65 : code - 97 < 26 ? code - 97 : base;
  const output: number[] = [];
  const split = input.lastIndexOf("-");
  for (let i = 0; i < Math.max(split, 0); i++) output.push(input.charCodeAt(i));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = split > 0 ? split + 1 : 0; index < input.length;) {
    const oldI = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (index >= input.length) return null;
      const d = digit(input.charCodeAt(index++));
      if (d >= base) return null;
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
      if (w > 0x10ffff) return null;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
};

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const serverOrigin = (input: string): Origin | null => {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  if (origin.scheme === "http" && !LOCAL_HOSTS.has(origin.host)) return null;
  return origin;
};
