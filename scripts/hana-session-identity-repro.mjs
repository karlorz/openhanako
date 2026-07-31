#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import {
  cdpCommand,
  connectWebSocket,
  evaluate,
  selectPageTarget,
} from "./hana-desktop-smoke-helper.mjs";

const PORT = 14592;
const OUT = path.join(process.cwd(), ".claude", "repro-no-active-session", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });

async function waitForMainPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = "none";
  while (Date.now() < deadline) {
    try {
      return await selectPageTarget(PORT, Math.min(2000, deadline - Date.now()));
    } catch (e) {
      last = e.message;
    }
    await delay(400);
  }
  throw new Error(`main page not ready: ${last}`);
}

const FIND_STORE = `
(() => {
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v.getState === 'function' && typeof v.setState === 'function') {
        const st = v.getState();
        if (st && Object.prototype.hasOwnProperty.call(st, 'pendingNewSession') && Array.isArray(st.sessions)) {
          return k;
        }
      }
    } catch {}
  }
  return null;
})()
`;

async function main() {
  // App should already be running with --remote-debugging-port=14592 from prior attempt.
  // If not, user/helper must restart.
  let page;
  try {
    page = await waitForMainPage(5000);
  } catch {
    console.log("[repro] main page missing; leave existing CDP or launch manually");
    page = await waitForMainPage(25000);
  }
  console.log("[repro] page", page.url);
  const ws = await connectWebSocket(page.webSocketDebuggerUrl);
  await cdpCommand(ws, "Runtime.enable");
  await cdpCommand(ws, "Page.enable");
  await delay(1500);

  const storeKey = await evaluate(ws, FIND_STORE);
  console.log("[repro] storeKey", storeKey);

  const snapExpr = (label) => `(() => {
    const key = ${JSON.stringify(storeKey)};
    const storeApi = key ? window[key] : null;
    const store = storeApi ? storeApi.getState() : null;
    const bodyText = document.body?.innerText?.slice(0, 2500) || '';
    return {
      label: ${JSON.stringify(label)},
      storeFound: !!store,
      pendingNewSession: store?.pendingNewSession ?? null,
      pendingDraftId: store?.pendingDraftId ?? null,
      currentSessionPath: store?.currentSessionPath ?? null,
      currentSessionId: store?.currentSessionId ?? null,
      welcomeVisible: store?.welcomeVisible ?? null,
      connected: store?.connected ?? null,
      sessionsCount: Array.isArray(store?.sessions) ? store.sessions.length : null,
      toasts: Array.isArray(store?.toasts) ? store.toasts.map(t => ({
        type: t.type,
        text: String(t.text||'').slice(0,180),
        dedupeKey: t.dedupeKey || null,
        hasAction: !!t.action,
      })) : null,
      bodyHasWelcome: /always here|总是在|永遠在|いつも/i.test(bodyText),
      bodyHasNoActive: /No active session|没有活跃|沒有活躍|アクティブなセッション/i.test(bodyText),
      bodySnippet: bodyText.replace(/\\s+/g, ' ').slice(0, 450),
    };
  })()`;

  const s1 = await evaluate(ws, snapExpr("boot"));
  fs.writeFileSync(path.join(OUT, "snapshot1-after-boot.json"), JSON.stringify(s1, null, 2));
  console.log("[repro] s1", JSON.stringify(s1, null, 2));

  const force = await evaluate(ws, `(() => {
    const key = ${JSON.stringify(storeKey)};
    const storeApi = key ? window[key] : null;
    if (!storeApi) return { ok: false, reason: 'store not found' };
    storeApi.setState({
      pendingNewSession: true,
      pendingDraftId: null,
      currentSessionPath: null,
      currentSessionId: null,
      welcomeVisible: true,
    });
    const st = storeApi.getState();
    return {
      ok: true,
      pendingNewSession: st.pendingNewSession,
      pendingDraftId: st.pendingDraftId,
      currentSessionPath: st.currentSessionPath,
      welcomeVisible: st.welcomeVisible,
    };
  })()`);
  fs.writeFileSync(path.join(OUT, "snapshot2-forced-incomplete.json"), JSON.stringify(force, null, 2));
  console.log("[repro] force", force);

  const s3 = await evaluate(ws, `(async () => {
    const key = ${JSON.stringify(storeKey)};
    const editor = document.querySelector('.ProseMirror, [contenteditable="true"], textarea');
    if (editor) {
      editor.focus();
      if (editor.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, 'repro no-active-session probe ' + Date.now());
      } else {
        editor.value = 'repro no-active-session probe ' + Date.now();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // TipTap may need input event via beforeinput; also try Enter
    const buttons = [...document.querySelectorAll('button')];
    const send = buttons.find(b => /send|发送|傳送|送信/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')))
      || document.querySelector('[data-testid="send"]');
    if (send) {
      send.click();
      await new Promise(r => setTimeout(r, 3500));
    } else if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 3500));
    }
    const store = key && window[key] ? window[key].getState() : null;
    const bodyText = document.body?.innerText?.slice(0, 3500) || '';
    return {
      editorFound: !!editor,
      sendClicked: !!send,
      sendLabel: send ? ((send.getAttribute('aria-label')||'') + ' ' + (send.textContent||'')).slice(0,100) : null,
      pendingNewSession: store?.pendingNewSession ?? null,
      pendingDraftId: store?.pendingDraftId ?? null,
      currentSessionPath: store?.currentSessionPath ?? null,
      currentSessionId: store?.currentSessionId ?? null,
      toasts: Array.isArray(store?.toasts) ? store.toasts.map(t => ({
        type: t.type,
        text: String(t.text||'').slice(0,180),
        dedupeKey: t.dedupeKey || null,
        hasAction: !!t.action,
      })) : null,
      bodyHasNoActive: /No active session|没有活跃|沒有活躍|アクティブなセッション/i.test(bodyText),
      bodyHasCreateFailed: /create failed|创建失败|建立失敗|Failed to create session/i.test(bodyText),
      bodySnippet: bodyText.replace(/\\s+/g, ' ').slice(0, 500),
    };
  })()`);
  fs.writeFileSync(path.join(OUT, "snapshot3-after-send.json"), JSON.stringify(s3, null, 2));
  console.log("[repro] s3", JSON.stringify(s3, null, 2));

  try {
    const shot = await cdpCommand(ws, "Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "screenshot.png"), Buffer.from(shot.data, "base64"));
    console.log("[repro] screenshot ok");
  } catch (e) {
    console.warn("[repro] screenshot fail", e.message);
  }

  let interpretation = "INCONCLUSIVE";
  if (s3?.bodyHasNoActive || (s3?.toasts || []).some((t) => /no active session/i.test(t.text || ""))) {
    interpretation = "REPRODUCED: no-active-session toast after forced incomplete identity + send";
  } else if (s3?.currentSessionPath) {
    interpretation = "NOT classic F1 on this build: heal/create succeeded after force+send";
  } else if (!s3?.sendClicked && !s3?.editorFound) {
    interpretation = "INCONCLUSIVE: no editor/send controls found";
  } else if (!storeKey) {
    interpretation = "INCONCLUSIVE: zustand store not exposed on window (need module-level eval or CDP coverage)";
  }

  const summary = {
    out: OUT,
    appVersion: "0.416.51",
    packagedHasHealAndSendSelfHeal: true,
    storeKey,
    snapshot1: s1,
    force,
    sendProbe: s3,
    interpretation,
    automation: {
      electronCdp: `http://127.0.0.1:${PORT}`,
      playwrightCliNote: "playwright-cli attaches Chrome on 9222; for HanaAgent use Electron CDP (this script / hana-desktop-smoke-helper)",
    },
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("[repro] SUMMARY", interpretation);
  console.log("[repro] OUT", OUT);
  ws.close();
}

main().catch((err) => {
  console.error("[repro] FAILED", err);
  process.exit(1);
});
