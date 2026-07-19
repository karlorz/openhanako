/**
 * Main-process LAN connect pre-validation (CSP bootstrapping).
 *
 * Isolated from desktop packaging/layout so upstream rewrites of
 * artifact-boot / OTA / server spawn do not force a human-merge of the
 * probe path. Renderer invokes via IPC channel "connect:probe".
 *
 * @param {{ fetchImpl: (url: string, init?: object) => Promise<Response> }} deps
 * @returns {(event: { senderFrame?: { url?: string } }, payload: { baseUrl?: string, credential?: string }) => Promise<object>}
 */
function createConnectProbeHandler({ fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("createConnectProbeHandler requires fetchImpl");
  }

  return async function handleConnectProbe(event, payload) {
    const baseUrl = String((payload && payload.baseUrl) || "").replace(/\/+$/, "");
    const credential = String((payload && payload.credential) || "");
    if (!baseUrl) return { ok: false, error: "baseUrl required" };
    if (!credential) return { ok: false, error: "credential required" };
    // SSRF guard: a compromised renderer could call this channel directly with an
    // arbitrary URL. Keep the scheme narrow here and reject redirects below so
    // net.fetch cannot silently expand the probed network boundary.
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: "baseUrl must be http(s)" };
    }
    // Sender validation (Electron Security §17): only accept probes from our own
    // renderer (file:// origin). Prevents cross-origin invoke exploitation.
    const senderUrl = event && event.senderFrame && event.senderFrame.url;
    if (!senderUrl || !senderUrl.startsWith("file://")) {
      return { ok: false, error: "forbidden sender" };
    }
    try {
      const loginRes = await fetchImpl(`${baseUrl}/api/web-auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (loginRes.status >= 300 && loginRes.status < 400) {
        return { ok: false, error: "login redirect blocked" };
      }
      if (!loginRes.ok) return { ok: false, error: `login HTTP ${loginRes.status}` };
      const idRes = await fetchImpl(`${baseUrl}/api/server/identity`, {
        redirect: "manual",
        headers: { Authorization: `Bearer ${credential}` },
      });
      if (idRes.status >= 300 && idRes.status < 400) {
        return { ok: false, error: "identity redirect blocked" };
      }
      if (!idRes.ok) return { ok: false, error: `identity HTTP ${idRes.status}` };
      const identity = await idRes.json();
      return { ok: true, identity };
    } catch (e) {
      // Expected network errors (DNS, connection refused, TLS) surface here as
      // {ok:false} rather than ipc rejections — gives the renderer a clean error
      // message without tripping wrapIpcHandler's error logger.
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
}

module.exports = {
  createConnectProbeHandler,
};
