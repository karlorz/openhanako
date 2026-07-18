import { afterEach, describe, expect, it, vi } from "vitest";
import loaderModule from "../shared/remote-server-release-loader.cjs";

const { createRemoteServerReleaseLoader } = loaderModule;

function serverRelease(tag = "v0.407.15-karlorz.1") {
  const bundle = `hanaagent-server-${tag}-linux-arm64.tar.gz`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: "2026-07-18T12:00:00.000Z",
    html_url: `https://github.com/karlorz/openhanako/releases/tag/${tag}`,
    assets: [
      { name: bundle, browser_download_url: `https://example.test/${bundle}` },
      { name: `${bundle}.sha256`, browser_download_url: `https://example.test/${bundle}.sha256` },
    ],
  };
}

function response(body: unknown, options: { next?: boolean; ok?: boolean; status?: number } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: options.ok !== false,
    status: options.status ?? 200,
    headers: {
      get(name: string) {
        if (name.toLowerCase() !== "link" || !options.next) return null;
        return '<https://api.github.com/repos/karlorz/openhanako/releases?per_page=100&page=2>; rel="next"';
      },
    },
    text: vi.fn().mockResolvedValue(text),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("remote server release loader", () => {
  it("uses the fixed fork URL and follows only bounded next pages", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([serverRelease("v0.407.15-karlorz.1")], { next: true }))
      .mockResolvedValueOnce(response([serverRelease("v0.407.15-karlorz.2")]));
    const load = createRemoteServerReleaseLoader({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });

    const result = await load();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/karlorz/openhanako/releases?per_page=100&page=1",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.github+json" }) }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/karlorz/openhanako/releases?per_page=100&page=2",
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "ready", source: "online", release: { tag: "v0.407.15-karlorz.2" } });
  });

  it("stops after page five and reports catalog truncation", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response([serverRelease()], { next: true }));
    const load = createRemoteServerReleaseLoader({ fetchImpl, now: () => 1_000 });

    const result = await load();

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.reasonCodes).toContain("release_catalog_truncated");
  });

  it("caches successful results and shares concurrent requests", async () => {
    let resolveFetch!: (value: ReturnType<typeof response>) => void;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => { resolveFetch = resolve; });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    let now = 1_000;
    const load = createRemoteServerReleaseLoader({ fetchImpl, now: () => now });

    const first = load();
    const concurrent = load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(response([serverRelease()]));
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);

    now += 599_999;
    const cached = await load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.source).toBe("cached");
    expect(cached.stale).toBe(false);
  });

  it("throttles repeated forced refreshes for thirty seconds", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([serverRelease("v0.407.15-karlorz.1")]))
      .mockResolvedValueOnce(response([serverRelease("v0.407.15-karlorz.2")]));
    const load = createRemoteServerReleaseLoader({ fetchImpl, now: () => now });
    await load();
    now += 1_000;
    const forced = await load({ force: true });
    now += 29_999;
    const throttled = await load({ force: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(forced.release?.tag).toBe("v0.407.15-karlorz.2");
    expect(throttled.release?.tag).toBe("v0.407.15-karlorz.2");
  });

  it("times out the request after ten seconds", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const load = createRemoteServerReleaseLoader({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    const pending = load();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      source: "none",
      errorCode: "release_catalog_timeout",
    });
  });

  it("times out when response headers arrive but the body stalls", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const stalledResponse = response([]);
    stalledResponse.text = vi.fn(() => new Promise<string>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const fetchImpl = vi.fn((_url: string, options: { signal?: AbortSignal }) => {
      requestSignal = options.signal;
      return Promise.resolve(stalledResponse);
    });
    const load = createRemoteServerReleaseLoader({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 });
    const pending = load();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      source: "none",
      errorCode: "release_catalog_timeout",
    });
  });

  it("rejects a combined release body over the configured bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(" ".repeat(2_097_153)));
    const load = createRemoteServerReleaseLoader({ fetchImpl, now: () => 1_000 });

    await expect(load()).resolves.toMatchObject({
      status: "unavailable",
      errorCode: "release_catalog_too_large",
    });
  });

  it("falls back to the last successful normalized result after refresh failure", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([serverRelease()]))
      .mockRejectedValueOnce(new Error("offline"));
    const load = createRemoteServerReleaseLoader({ fetchImpl, now: () => now });
    await load();
    now += 600_001;

    const result = await load();

    expect(result).toMatchObject({
      status: "ready",
      source: "cached",
      stale: true,
      release: { tag: "v0.407.15-karlorz.1" },
      errorCode: "release_catalog_request_failed",
    });
  });

  it("returns unavailable without cache and never exposes trusted tokens", async () => {
    const token = "github-secret-token-value";
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string, options: { headers?: Record<string, string> }) => {
      seenHeaders.push(options.headers ?? {});
      throw new Error("offline");
    });
    const logs: string[] = [];
    const load = createRemoteServerReleaseLoader({
      fetchImpl,
      now: () => 1_000,
      env: { GITHUB_TOKEN: token },
      log: (message: string) => logs.push(message),
    });

    const result = await load();

    expect(seenHeaders[0].Authorization).toBe(`Bearer ${token}`);
    expect(result).toMatchObject({ status: "unavailable", source: "none", stale: false });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });
});
