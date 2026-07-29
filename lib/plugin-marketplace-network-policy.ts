import dns from "dns";
import net from "net";
import { promisify } from "util";

export const DEFAULT_MARKETPLACE_MAX_REDIRECTS = 3;
export const DEFAULT_MARKETPLACE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MARKETPLACE_OVERALL_TIMEOUT_MS = 30_000;
export const DEFAULT_ALLOWED_HTTPS_PORTS = new Set([443, 8443]);

const dnsLookup = promisify(dns.lookup);

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface PinnedHttpsUrl {
  url: URL;
  pinnedAddresses: string[];
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  allowQuery?: boolean;
  allowFragment?: boolean;
  allowedPorts?: Set<number>;
}

export interface SanitizedAcquisitionError {
  code: string;
  message: string;
}

export function assertPublicHttpsUrl(
  raw: string,
  options: {
    allowQuery?: boolean;
    allowFragment?: boolean;
    allowedPorts?: Set<number>;
  } = {},
): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "URL is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Malformed URL");
  }
  if (url.protocol !== "https:") {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Only HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "URL credentials are not allowed");
  }
  if (!options.allowQuery && url.search) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "URL query strings are not allowed");
  }
  if (!options.allowFragment && url.hash) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "URL fragments are not allowed");
  }
  if (!url.hostname) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "URL host is required");
  }
  const hostLower = url.hostname.toLowerCase();
  if (hostLower === "localhost" || hostLower.endsWith(".localhost")) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "localhost is not allowed");
  }
  // Reject literal private/reserved IP hostnames before DNS.
  if (net.isIP(url.hostname) && isDeniedIpAddress(url.hostname)) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Private or reserved IP hosts are not allowed");
  }
  const port = url.port ? Number(url.port) : 443;
  const allowedPorts = options.allowedPorts || DEFAULT_ALLOWED_HTTPS_PORTS;
  if (!allowedPorts.has(port)) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", `Port ${port} is not allowed`);
  }
  return url;
}

export function isDeniedIpAddress(address: string): boolean {
  if (!address) return true;
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    if (net.isIPv4(mapped)) {
      return isDeniedIpv4(mapped);
    }
  }
  if (net.isIPv4(ip)) return isDeniedIpv4(ip);
  if (net.isIPv6(ip)) return isDeniedIpv6(ip);
  return true;
}

function isDeniedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isDeniedIpv6(ip: string): boolean {
  // Normalize compressed forms via URL parsing trick is unreliable; use simple prefixes.
  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  // IPv4-mapped handled by caller.
  // Discard/unspecified-ish
  if (ip === "0:0:0:0:0:0:0:0" || ip === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export async function resolveAndPinPublicHttpsUrl(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<PinnedHttpsUrl> {
  const url = assertPublicHttpsUrl(raw, options);
  if (net.isIP(url.hostname)) {
    if (isDeniedIpAddress(url.hostname)) {
      throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Private or reserved IP hosts are not allowed");
    }
    return { url, pinnedAddresses: [url.hostname] };
  }

  const lookup = options.lookup || defaultLookup;
  const answers = await lookup(url.hostname);
  if (!answers.length) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "DNS resolution returned no addresses");
  }
  const pinned: string[] = [];
  for (const answer of answers) {
    if (isDeniedIpAddress(answer.address)) {
      throw policyError(
        "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN",
        "DNS resolution included a private or reserved address",
      );
    }
    pinned.push(answer.address);
  }
  return { url, pinnedAddresses: pinned };
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  try {
    const result = await dnsLookup(hostname, { all: true, verbatim: true }) as unknown;
    if (Array.isArray(result)) {
      return result.map((item: any) => ({
        address: String(item.address),
        family: Number(item.family) || 4,
      }));
    }
    // Older Node single-result shape
    const single = result as { address: string; family: number };
    return [{ address: single.address, family: single.family }];
  } catch (err: any) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", `DNS lookup failed: ${err?.message || err}`);
  }
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<string> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "fetch implementation is unavailable");
  }
  const maxRedirects = options.maxRedirects ?? DEFAULT_MARKETPLACE_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MARKETPLACE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MARKETPLACE_OVERALL_TIMEOUT_MS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await resolveAndPinPublicHttpsUrl(current, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(pinned.url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      } as RequestInit);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Redirect without Location");
        }
        if (hop >= maxRedirects) {
          throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Redirect limit exceeded");
        }
        // Revalidate every hop as a full absolute/relative HTTPS URL.
        current = new URL(location, pinned.url).toString();
        continue;
      }

      if (!response.ok) {
        throw policyError(
          "PLUGIN_MARKETPLACE_SOURCE_INVALID",
          `HTTP ${response.status}`,
        );
      }

      const text = await readBodyWithLimit(response, maxBytes);
      return text;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Redirect limit exceeded");
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  // Prefer content-length early reject when present.
  const cl = response.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
  }

  if (response.body && typeof (response.body as any).getReader === "function") {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
        }
        chunks.push(value);
      }
    }
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return merged.toString("utf8");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
  }
  return text;
}

export function sanitizeAcquisitionError(
  err: unknown,
  options: { forRemote?: boolean } = {},
): SanitizedAcquisitionError {
  // Accept Error, plain { message, code }, or other values — never String(object) → "[object Object]".
  let message: string;
  if (err instanceof Error) {
    message = err.message || String(err);
  } else if (err && typeof err === "object" && typeof (err as any).message === "string") {
    message = (err as any).message;
  } else if (typeof err === "string") {
    message = err;
  } else if (err == null) {
    message = "source error";
  } else {
    try {
      message = JSON.stringify(err);
    } catch {
      message = "source error";
    }
  }
  const code = (err as any)?.code
    || (message.includes("Redirect") ? "PLUGIN_MARKETPLACE_FETCH_LIMIT"
      : message.includes("size limit") || message.includes("timed out") || message.includes("bytes")
        ? "PLUGIN_MARKETPLACE_FETCH_LIMIT"
        : message.includes("HTTPS") || message.includes("DNS") || message.includes("private")
          ? "PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN"
          : "PLUGIN_MARKETPLACE_SOURCE_INVALID");

  if (!options.forRemote) {
    return { code, message };
  }

  let sanitized = message
    .replace(/\/(?:Users|home|var|tmp|private)\/[^\s)"']+/gi, "[redacted-path]")
    .replace(/[A-Za-z]:\\[^\s)"']+/g, "[redacted-path]")
    .replace(/plugin-marketplace-cache\/[A-Za-z0-9._-]+/g, "plugin-marketplace-cache/[redacted]");

  if (sanitized.length > 200) {
    sanitized = `${sanitized.slice(0, 200)}…`;
  }
  return { code, message: sanitized };
}

function policyError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
