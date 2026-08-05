import dns from "dns";
import net from "net";
import crypto from "crypto";
import { promisify } from "util";

export const DEFAULT_MARKETPLACE_MAX_REDIRECTS = 3;
export const DEFAULT_MARKETPLACE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_RELEASE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MARKETPLACE_OVERALL_TIMEOUT_MS = 30_000;
export const DEFAULT_ALLOWED_HTTPS_PORTS = new Set([443, 8443]);

const dnsLookup = promisify(dns.lookup);

// Strict dotted-quad IPv4 tail (octets 0-255, no leading zeros — matches net.isIPv6 acceptance).
const IPV4_QUAD_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_GROUP_RE = /^[0-9a-f]{1,4}$/;

/** Convert a trailing dotted-quad IPv4 tail into two 4-digit hex groups, or null. */
function ipv4QuadToHexGroups(quad: string): string[] | null {
  if (!IPV4_QUAD_RE.test(quad)) return null;
  const [a, b, c, d] = quad.split(".").map((octet) => Number(octet));
  return [
    ((a << 8) | b).toString(16).padStart(4, "0"),
    ((c << 8) | d).toString(16).padStart(4, "0"),
  ];
}

/** Validate and zero-pad hex groups; returns exactly 8 groups of 4 lowercase hex digits, or null. */
function normalizeIpv6Groups(groups: string[]): string[] | null {
  if (groups.length !== 8) return null;
  const out: string[] = [];
  for (const group of groups) {
    if (!IPV6_GROUP_RE.test(group)) return null;
    out.push(group.padStart(4, "0"));
  }
  return out;
}

/**
 * Expand any IPv6 textual form (including IPv4-mapped/compatible mixed forms and
 * zone identifiers) into exactly 8 groups of 4 lowercase hex digits, or null when
 * the input cannot be parsed into a canonical 8-group address.
 */
export function expandIpv6Groups(ip: string): string[] | null {
  if (!ip || !ip.includes(":")) return null;
  const value = String(ip).trim().toLowerCase();
  // Zone identifiers ("fe80::1%eth0") are interface-scope metadata; the address
  // itself classifies the same with or without the zone, so strip it.
  const noZone = value.split("%")[0];
  const parts = noZone.split("::");
  if (parts.length > 2) return null; // at most one "::" compression
  if (parts.length === 1) {
    // No compression: exactly eight groups; the last may be a dotted-quad tail (2 groups).
    const groups = parts[0].split(":");
    const last = groups[groups.length - 1];
    if (last !== undefined && last.includes(".")) {
      const tail = ipv4QuadToHexGroups(last);
      if (!tail) return null;
      if (groups.length - 1 + tail.length !== 8) return null;
      return normalizeIpv6Groups([...groups.slice(0, -1), ...tail]);
    }
    if (groups.length !== 8) return null;
    return normalizeIpv6Groups(groups);
  }
  const [head, tail] = parts;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // A dotted-quad tail may only appear as the final element, where it occupies two groups.
  const last = right[right.length - 1];
  const quadTail = last !== undefined && last.includes(".") ? ipv4QuadToHexGroups(last) : null;
  if (last !== undefined && last.includes(".") && !quadTail) return null;
  for (const group of [...left, ...right.slice(0, -1)]) {
    if (group.includes(".")) return null; // dotted quad anywhere but the tail
  }
  const total = left.length + (quadTail ? right.length - 1 + quadTail.length : right.length);
  if (total >= 8) return null; // "::" must expand to at least one zero group
  const middle = Array(8 - total).fill("0000");
  return normalizeIpv6Groups([...left, ...middle, ...(quadTail ? [...right.slice(0, -1), ...quadTail] : right)]);
}

/** "10.0.0.1" from the low 32 bits of an IPv4-mapped address, or null. */
export function mappedIpv4FromGroups(groups: string[]): string | null {
  if (groups.length !== 8) return null;
  const prefix = groups.slice(0, 5);
  if (prefix.some((g) => g !== "0000") || groups[5] !== "ffff") return null;
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Canonical form of an IP literal: dotted-decimal IPv4 (including IPv4-mapped
 * forms) or 8-group expanded lowercase IPv6. Throws PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN
 * for NAT64 prefixes, IPv4-compatible forms, and anything unparseable.
 */
export function canonicalizeIpAddress(raw: string): string {
  const value = String(raw).trim().toLowerCase();
  if (!value) throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "IP address is empty");
  if (net.isIPv4(value)) return value;
  if (!net.isIPv6(value)) throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Not an IP address");
  const groups = expandIpv6Groups(value);
  if (!groups) throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Malformed IPv6 address");
  const mapped = mappedIpv4FromGroups(groups);
  if (mapped) return mapped;
  const expanded = groups.join(":");
  if (expanded.startsWith("0064:ff9b:")) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "NAT64 addresses are not allowed");
  }
  if (groups[0] === "2001") {
    const second = parseInt(groups[1], 16);
    if (second >= 0x20 && second <= 0x2f) {
      throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "NAT64 addresses are not allowed");
    }
  }
  const ipv4Compatible = groups.slice(0, 6).every((g) => g === "0000")
    && (groups[6] !== "0000" || groups[7] !== "0000");
  if (ipv4Compatible) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "IPv4-compatible IPv6 addresses are not allowed");
  }
  return expanded;
}

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

export interface SafeFetchBytesOptions extends SafeFetchOptions {
  expectedSha256?: string;
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
  const normalizedHostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const hostLower = normalizedHostname.toLowerCase();
  if (hostLower === "localhost" || hostLower.endsWith(".localhost")) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "localhost is not allowed");
  }
  // Reject literal private/reserved IP hostnames before DNS.
  if (net.isIP(normalizedHostname) && isDeniedIpAddress(normalizedHostname)) {
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
  let canonical: string;
  try {
    canonical = canonicalizeIpAddress(address);
  } catch {
    return true;
  }
  if (canonical.includes(".")) return isDeniedIpv4(canonical);
  return isDeniedIpv6(canonical);
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

function isDeniedIpv6(expanded: string): boolean {
  const groups = expanded.split(":");
  const first = parseInt(groups[0], 16);
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") return true; // ::
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

export async function resolveAndPinPublicHttpsUrl(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<PinnedHttpsUrl> {
  const url = assertPublicHttpsUrl(raw, options);
  const normalizedHostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (net.isIP(normalizedHostname)) {
    if (isDeniedIpAddress(normalizedHostname)) {
      throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Private or reserved IP hosts are not allowed");
    }
    return { url, pinnedAddresses: [normalizedHostname] };
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
  const { body } = await safeFetchBuffer(rawUrl, options, "application/json, text/plain, */*");
  return body.toString("utf8");
}

export async function safeFetchBytes(
  rawUrl: string,
  options: SafeFetchBytesOptions = {},
): Promise<{ body: Buffer; sha256: string }> {
  const expected = options.expectedSha256;
  if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_INVALID", "Expected sha256 must be 64 lowercase hex characters");
  }
  const { body } = await safeFetchBuffer(
    rawUrl,
    {
      ...options,
      allowQuery: options.allowQuery ?? true,
      maxBytes: options.maxBytes ?? DEFAULT_MARKETPLACE_RELEASE_MAX_BYTES,
    },
    "application/zip, application/octet-stream, */*",
  );
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (expected && sha256 !== expected) {
    throw policyError("PLUGIN_MARKETPLACE_SOURCE_INVALID", "Plugin release sha256 mismatch");
  }
  return { body, sha256 };
}

async function safeFetchBuffer(
  rawUrl: string,
  options: SafeFetchOptions,
  accept: string,
): Promise<{ body: Buffer; finalUrl: string }> {
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
        headers: { Accept: accept },
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw policyError("PLUGIN_MARKETPLACE_SOURCE_FORBIDDEN", "Redirect without Location");
        if (hop >= maxRedirects) throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Redirect limit exceeded");
        current = new URL(location, pinned.url).toString();
        continue;
      }
      if (!response.ok) throw policyError("PLUGIN_MARKETPLACE_SOURCE_INVALID", `HTTP ${response.status}`);
      return { body: await readBodyBufferWithLimit(response, maxBytes), finalUrl: pinned.url.href };
    } catch (err: any) {
      if (err?.name === "AbortError") throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Request timed out");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Redirect limit exceeded");
}

async function readBodyBufferWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const cl = response.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
  }

  if (response.body && typeof (response.body as any).getReader === "function") {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) {
    throw policyError("PLUGIN_MARKETPLACE_FETCH_LIMIT", "Response body exceeds size limit");
  }
  return body;
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
