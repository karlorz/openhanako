#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const UPSTREAM_REPO = "liliMozi/openhanako";
export const ISSUE_DOCS_DIR = path.join(ROOT, "docs", "upstream-issues");
export const DRAFTS_DIR = path.join(ISSUE_DOCS_DIR, "drafts");

export const TRACKED_FIXES = [
  {
    id: "lan-csp-ws-auth",
    title: "LAN/Tailscale desktop connect fails due to CSP bootstrapping and WebSocket auth",
    classification: "upstream",
    status: "existing/open",
    commits: ["80ea81ae", "ae7fd31c"],
    grouping: "LAN query-token/auth bug fix",
    existingIssue: {
      number: 1749,
      url: "https://github.com/liliMozi/openhanako/issues/1749",
      state: "OPEN",
    },
    relatedIssues: [
      {
        number: 1811,
        url: "https://github.com/liliMozi/openhanako/issues/1811",
        state: "CLOSED",
        relation: "newer LAN WebSocket auth and CSP reconnect report",
      },
    ],
    searches: [
      "LAN WebSocket query token CSP auth",
      "Tailscale desktop CSP WebSocket 403",
      "connect:probe device_credential query token",
    ],
    resultMustInclude: /LAN|Tailscale|WebSocket|CSP|Electron|connect:probe|device_credential/i,
    notes: [
      "Existing upstream issues cover the LAN connect regression boundary.",
      "Check this issue during every upstream release-tag sync.",
    ],
  },
  {
    id: "lan-query-token-network-hardening",
    title: "LAN query-token URLs need no-referrer and non-following connection probes",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["7ff3ac38"],
    grouping: "fold into LAN query-token/auth bug fix unless reviewed separately",
    searches: [
      "Referrer-Policy token query credential",
      "LAN query token Referer credential leak",
      "connect probe redirect SSRF Electron",
    ],
    resultMustInclude: /Referrer|Referer|token|credential|redirect|SSRF|Electron|LAN|CSP/i,
    relatedIssues: [
      {
        number: 1749,
        url: "https://github.com/liliMozi/openhanako/issues/1749",
        state: "OPEN",
        relation: "LAN/Tailscale CSP and WebSocket auth bug",
      },
      {
        number: 1811,
        url: "https://github.com/liliMozi/openhanako/issues/1811",
        state: "CLOSED",
        relation: "newer LAN WebSocket auth and CSP reconnect report",
      },
    ],
    notes: [
      "No exact upstream issue found in the 2026-06-19 search.",
      "This is a hardening companion to LAN query-token support; keep it local, and if a human later posts manually, prefer folding it into the LAN auth fix unless upstream asks for a separate report.",
    ],
    draft: {
      file: "lan-query-token-network-hardening.md",
      title: "[Bug] LAN query-token URLs need referrer and redirect hardening",
      body: [
        "## Summary",
        "",
        "LAN desktop connections need query-token fallback for browser `WebSocket` and other browser-loadable URLs, because those APIs cannot attach an `Authorization` header. Once a device credential can appear in URLs, renderer pages and server responses should prevent `Referer` leakage. Any Electron main-process connection probe used to work around renderer CSP should also block redirects so an initial trusted probe cannot silently expand to another network target.",
        "",
        "## Expected",
        "",
        "- Renderer HTML uses `Referrer-Policy: no-referrer` or an equivalent referrer policy.",
        "- Server responses set `Referrer-Policy: no-referrer` or an equivalent header.",
        "- Main-process connection probes use non-following fetches and reject redirects.",
        "- LAN query-token support does not introduce credential leakage through browser referrers or redirect-following probes.",
        "",
        "## Actual",
        "",
        "- LAN query-token support can place a device credential in URL query strings for WebSocket/resource-style browser loads.",
        "- Without a referrer policy, any future external navigation or third-party subresource path can leak the credential-bearing URL.",
        "- A main-process probe that follows redirects can be turned into a broader network probe than the user-entered server URL.",
        "",
        "## Related issues",
        "",
        "- #1749 covers the original LAN/Tailscale CSP and WebSocket auth regression.",
        "- #1811 is a newer LAN WebSocket auth and CSP reconnect report.",
        "",
        "## Local fork fix",
        "",
        "- Add `<meta name=\"referrer\" content=\"no-referrer\">` to renderer HTML entry points.",
        "- Add `Referrer-Policy: no-referrer` to server responses before route handling.",
        "- Use `redirect: \"manual\"` in the Electron `connect:probe` login and identity fetches and reject 3xx responses.",
      ],
    },
  },
  {
    id: "remote-attachment-preview-persistence",
    title: "Remote desktop session attachments lose preview after chat switch",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["434c3e30"],
    grouping: "fix: preserve remote session attachment previews",
    relatedIssues: [
      {
        number: 2188,
        url: "https://github.com/liliMozi/openhanako/issues/2188",
        state: "OPEN",
        relation: "WebUI session-load race can discard the SessionFile registry",
      },
    ],
    searches: [
      "remote attachment preview upload Conversation Files",
      "session files preview remote desktop upload blob",
      "remote resource preview chat switch Conversation Files",
    ],
    resultMustInclude: /remote|attachment|preview|Conversation Files|session files|resource|upload/i,
    notes: [
      "No exact upstream issue covers the fork's remote client-path upload, scoped resource URL, and CSP behavior.",
      "#2188 is related because it fixes a WebUI session-load race that can discard the SessionFile registry; it does not cover the fork-specific remote transport and preview ownership boundary.",
      "Draft only; human approval changes wording state, and only a human may post manually outside an agent session.",
    ],
    draft: {
      file: "remote-attachment-preview-persistence.md",
      title: "[Bug] Remote desktop session attachments lose previews after switching chats",
      body: [
        "## Summary",
        "",
        "When the macOS desktop app is connected to a remote Hana server, pasted or uploaded local files can be persisted in a form that the remote Linux server cannot later resolve. The current chat can show transient inline bytes, but after switching chats and returning, chat thumbnails and Conversation Files previews can disappear.",
        "",
        "## Expected",
        "",
        "- Local desktop-owned files are uploaded to the active remote server before send.",
        "- Persisted remote session files resolve through server resource URLs.",
        "- Runtime CSP allows only the active remote HTTP(S) origin for image and media previews.",
        "- Chat thumbnails and Conversation Files previews survive chat switching.",
        "",
        "## Actual",
        "",
        "- The remote server can receive local macOS paths it cannot import.",
        "- Previews may rely on transient inline bytes that disappear after the active chat changes.",
        "- Older session attachments may no longer render in Conversation Files.",
        "",
        "## Related upstream issue",
        "",
        "- #2188 fixes a WebUI session-load race that can discard the SessionFile registry and leave the Conversation Files panel empty.",
        "- It is related but not equivalent: it does not cover uploading client-owned desktop bytes to a remote server, scoped resource URL synthesis, or runtime remote-origin CSP.",
        "",
        "## Local fork fix",
        "",
        "- Upload client-owned desktop files through `/api/upload-blob` when connected to a remote server.",
        "- Synthesize `/api/resources/res_<fileId>/content` URLs for remote session files when no explicit resource link exists.",
        "- Scope the active remote HTTP(S) origin into runtime CSP `img-src` and `media-src` without widening to bare `http:` or `https:`.",
        "",
        "## Verification",
        "",
        "- Paste or upload an image through a remote desktop connection.",
        "- Send it, switch to another chat, then return.",
        "- Confirm both the chat thumbnail and Conversation Files preview still render.",
      ],
    },
  },
  {
    id: "desktop-temp-upload-session-cache-materialization",
    title: "Desktop temp upload attachments should be materialized into session cache",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["ce498f68"],
    grouping: "fix: materialize temp uploads to session cache before send",
    searches: [
      "temp upload session cache attachment preview",
      "upload attachment preview temp file deleted",
      "session-files attachment materialize upload",
    ],
    resultMustInclude: /temp|upload|attachment|preview|session-files|cache|file/i,
    notes: [
      "No exact upstream issue found in the 2026-06-19 search.",
      "This is adjacent to remote attachment persistence but covers local desktop temp-upload paths before send.",
    ],
    draft: {
      file: "desktop-temp-upload-session-cache-materialization.md",
      title: "[Bug] Desktop temp upload attachments can outlive their source temp files",
      body: [
        "## Summary",
        "",
        "Desktop upload flows can pass display attachments backed by temporary upload paths. If those paths are later cleaned up or are not stable for the session lifecycle, message attachment previews and prompt file references can point at files that no longer exist.",
        "",
        "## Expected",
        "",
        "- Files selected or pasted through desktop upload flows are copied into the session-owned cache before send.",
        "- Display attachment paths and session file refs point at stable session-cache paths.",
        "- The original temp upload path is not required after the message is submitted.",
        "- Materialization refuses symlink sources and avoids clobbering existing cached files.",
        "",
        "## Actual",
        "",
        "- A display attachment can retain its original temp upload path.",
        "- Later cleanup of the temp location can break preview rendering or downstream file reference resolution.",
        "",
        "## Local fork fix",
        "",
        "- Copy temp upload display attachments into the session-files cache during desktop session submission.",
        "- Use exclusive copies and a bounded unique-name loop to avoid overwriting existing files.",
        "- Reject symlink temp upload sources and fall back to the original path on materialization failure so sending does not regress.",
      ],
    },
  },
  {
    id: "session-replay-marker-only-image-regenerate",
    title: "Regenerate on persisted marker-only image turns can resend unsupported direct image payloads",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["4c82293b"],
    grouping: "fix: replay persisted marker-only image turns without provider image_url rejection",
    searches: [
      "regenerate image replay 400",
      "session-meta no messages regenerate image",
      "image_url provider 400 replay",
    ],
    resultMustInclude: /regenerate|replay|image_url|session-meta|provider|messages/i,
    notes: [
      "No exact upstream issue found in the 2026-06-30 search.",
      "Observed against sg01 as POST /api/sessions/latest-user-message/replay returning HTTP 400 after an image turn; affected sessions could later appear as '(no messages)' after metadata/index churn.",
    ],
    draft: {
      file: "session-replay-marker-only-image-regenerate.md",
      title: "[Bug] Regenerate on image turns can replay unsupported direct image payloads",
      body: [
        "## Summary",
        "",
        "Regenerating a persisted user turn that contains only `[attached_image: ...]` markers can fail with HTTP 400. The replay path can rebuild direct image payloads from persisted marker text instead of preserving the original marker/path send semantics. Providers that reject that direct image payload variant, such as an `image_url`-style image block, then reject the replay request.",
        "",
        "A related failure mode appears when large per-session metadata grows past the safe parse limit: the session index can fail to hydrate and chats may appear as `(no messages)` even though their JSONL transcript still exists.",
        "",
        "## Expected",
        "",
        "- Persisted marker-only image turns replay as path/marker-backed inputs, not synthesized direct provider image payloads.",
        "- Trusted optimistic/display-message image attachments may still be used as a fallback before the user turn is persisted.",
        "- Oversized aggregate `session-meta.json` files compact large snapshots into sidecars instead of dropping unrelated entries or becoming unreadable.",
        "- Replay HTTP 400 errors expose useful server/provider error detail to the desktop UI.",
        "",
        "## Actual",
        "",
        "- Regenerate on a persisted image turn can reread the image path and send a direct image payload that differs from the original marker-backed submission.",
        "- The provider can reject the generated payload and `/api/sessions/latest-user-message/replay` returns 400.",
        "- Oversized session metadata can make affected chats show `(no messages)` after restart or session reload.",
        "",
        "## Local fork fix",
        "",
        "- Stop synthesizing direct image payloads for persisted marker-only replay turns.",
        "- Keep direct image reconstruction only for trusted display attachments when no persisted source entry exists, such as optimistic client messages.",
        "- Compact oversized `session-meta.json` by forcing medium prompt/memory snapshots into `session-meta-payloads/` sidecars, with path containment checks on hydration.",
        "- Include JSON or text response-body detail in `hanaFetch` HTTP errors.",
        "",
        "## Verification",
        "",
        "- Create an image-backed user message and regenerate it after persistence.",
        "- Confirm `/api/sessions/latest-user-message/replay` returns 200 instead of 400.",
        "- Restart/reload and confirm the chat list still shows the original title/messages instead of `(no messages)`.",
      ],
    },
  },
  {
    id: "toolgroup-file-detail-link-context",
    title: "Tool file-detail links lose session context",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["b9d8a730"],
    grouping: "fix: preserve session link context for tool file-detail links",
    searches: [
      "ToolGroupBlock file detail link session",
      "file detail openInternalLink session context",
      "tool file detail link message block context",
    ],
    resultMustInclude: /ToolGroupBlock|tool|file|detail|link|session|context|openInternalLink/i,
    notes: [
      "No exact upstream issue found in the 2026-06-30 search.",
      "Desktop UX bug adjacent to markdown/file links: tool detail links need the same session provenance as message-block links.",
    ],
    draft: {
      file: "toolgroup-file-detail-link-context.md",
      title: "[Bug] Tool file-detail links lose session provenance",
      body: [
        "## Summary",
        "",
        "Tool detail links rendered inside assistant tool groups can open with only `{ origin: 'session' }`, while normal markdown/file links in the same assistant message carry full session context such as `sessionPath`, `messageId`, and `blockIdx`. That makes file-detail links harder to resolve and inspect with the same provenance as surrounding message content.",
        "",
        "## Expected",
        "",
        "- Tool detail links receive the same session link context as other links in the assistant message block.",
        "- Click and context-menu open paths both preserve `sessionPath`, `messageId`, and `blockIdx` when available.",
        "- Existing tool groups outside a message context continue to work with a safe session-origin fallback.",
        "",
        "## Actual",
        "",
        "- `ToolGroupBlock` rendered detail links with a bare `{ origin: 'session' }` context.",
        "- The click handler and context menu did not include the assistant message's full session provenance.",
        "",
        "## Local fork fix",
        "",
        "- Thread `linkContext` from `AssistantMessage` into `ToolGroupBlock`.",
        "- Pass that context through `ToolIndicator` click and context-menu handlers.",
        "- Keep a `{ origin: 'session' }` fallback for standalone tool groups.",
        "",
        "## Verification",
        "",
        "- Render a tool group with a file-detail link inside an assistant message.",
        "- Click and right-click the detail link.",
        "- Confirm `openInternalLink` receives the full session context including `sessionPath`, `messageId`, and `blockIdx`.",
      ],
    },
  },
  {
    id: "provider-model-removal-persistence",
    title: "Provider model removal can leave deleted models in local provider plugin definitions",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["v0.346.18-karlorz.6"],
    grouping: "fix: make provider model removal persist for slash-bearing local provider models",
    searches: [
      "provider model remove custom models",
      "model deletion remote server provider",
      "ProviderModelList remove model",
      "custom provider slash model id",
    ],
    resultMustInclude: /provider|model|custom|delete|remove|slash|remote|server/i,
    notes: [
      "No exact upstream issue found in the 2026-07-01 search.",
      "Observed against sg01 in remote server mode, but root cause is shared: broad config saves and local provider plugin model merging can reintroduce deleted slash-bearing models.",
    ],
    draft: {
      file: "provider-model-removal-persistence.md",
      title: "[Bug] Provider model removal can fail to persist for slash-bearing local provider models",
      body: [
        "## Summary",
        "",
        "Removing an added provider model from Settings can appear to succeed but the model can reappear after refresh, especially for local/custom providers and model ids containing slashes such as `vendor/model-a`. The failure was first observed through a remote Hana server connection, but the persistence path is shared with local provider plugin definitions.",
        "",
        "## Expected",
        "",
        "- Clicking remove for an added provider model deletes that exact model from the provider registry.",
        "- Model ids containing `/` are matched as model ids, not split or left URL-encoded.",
        "- Saving an explicit provider `models` list replaces the local provider plugin model list, including the empty-list case after the last model is removed.",
        "- Refreshing Settings or reconnecting to a remote server does not bring the deleted model back.",
        "",
        "## Actual",
        "",
        "- The Settings UI removed models by sending a broad `/api/config` provider rewrite instead of the dedicated provider-model delete endpoint.",
        "- The provider model route could receive a still-encoded path param such as `vendor%2Fmodel-a`, so slash-bearing ids were not always removed from the registry.",
        "- Local provider plugin saves merged existing plugin models back into the explicit `models` list, so `models: []` could be normalized back to the prior plugin definition.",
        "",
        "## Local fork fix",
        "",
        "- Use `DELETE /api/providers/:providerId/models/:modelId` from `ProviderModelList` for model removal.",
        "- Decode provider model route params once before calling registry update/remove operations.",
        "- Treat an explicit `models` field in local provider config as a replacement list; only merge existing plugin models when the save did not include `models`.",
        "",
        "## Verification",
        "",
        "- Add a slash-bearing model such as `vendor/model-a` to a local/custom provider.",
        "- Remove it through Settings.",
        "- Refresh Settings or reconnect through a remote server and confirm the model does not return.",
        "- Regression tests should cover the UI delete endpoint, encoded route params, and local provider plugin persistence.",
      ],
    },
  },
  {
    id: "vision-capability-settings-sot",
    title: "Vision auxiliary misses custom-provider models until capability re-toggle Save",
    classification: "upstream",
    status: "local-verified",
    commits: ["a98f86a9"],
    grouping: "fix: provider catalog is SoT for vision capability; no dictionary-only UI lie",
    searches: [
      "vision auxiliary model dropdown empty",
      "custom provider model image capability persist",
      "vision model must support image input",
      "auxiliary vision model settings",
      "known-model-fallbacks image true custom provider",
    ],
    resultMustInclude: /vision|image|auxiliary|capability|provider|model|known-model|dropdown/i,
    relatedIssues: [
      {
        number: 1904,
        url: "https://github.com/liliMozi/openhanako/issues/1904",
        state: "OPEN",
        relation: "umbrella: custom provider model capabilities/context edits do not reliably take effect",
      },
      {
        number: 538,
        url: "https://github.com/liliMozi/openhanako/issues/538",
        state: "OPEN",
        relation: "dynamic model ids miss catalog; UI capability switches as durable SoT",
      },
      {
        number: 594,
        url: "https://github.com/liliMozi/openhanako/issues/594",
        state: "OPEN",
        relation: "discovery auto-mark multimodal (optional follow-up, not required for this fix)",
      },
      {
        number: 1854,
        url: "https://github.com/liliMozi/openhanako/issues/1854",
        state: "CLOSED",
        relation: "historical: vision auxiliary dropdown empty (Ollama)",
      },
      {
        number: 1919,
        url: "https://github.com/liliMozi/openhanako/issues/1919",
        state: "CLOSED",
        relation: "historical: custom provider vision toggle save regression",
      },
    ],
    notes: [
      "Local fork fix shipped and UAT-passed 2026-07-26 (commit a98f86a9).",
      "Root cause: Settings UI could show Vision ON from dictionary/reference while provider catalog lacked image; runtime Vision auxiliary filters projected input only.",
      "Do not treat known-model-fallbacks.json as day-to-day correctness path; optional catalog convenience only.",
      "Hybrid Save: materialize true capabilities always; materialize false only when catalog already had the field or the user toggled (preserves Ollama inference).",
    ],
    draft: {
      file: "vision-capability-settings-sot.md",
      title: "[Bug] Vision auxiliary model picker misses models until capability re-toggle because Settings catalog is not SoT",
      body: [
        "## Summary",
        "",
        "The Vision auxiliary model dropdown only lists models whose runtime projection has `input` including `\"image\"`. For custom OpenAI-compatible providers, a model can appear Vision-capable in the model edit panel (dictionary/reference merge) while the provider catalog still has a bare string id. Saving without re-toggling Vision did not persist `image: true`, so the model never appeared in Vision auxiliary until the user toggled Vision off and on and saved again.",
        "",
        "This is a Settings catalog vs dictionary precedence bug, not a missing hard-coded fallback entry. `known-model-fallbacks.json` may stay outdated; user-edited provider model fields must remain the durable source of truth.",
        "",
        "## Expected",
        "",
        "- Provider catalog model object fields (`image` / legacy `vision`, `video`, `audio`, `reasoning`) are the durable authority after Settings add/edit.",
        "- The model edit panel does not show Vision ON solely by borrowing another provider's known-models partition when the current provider is known.",
        "- Saving a model with Vision shown ON materializes `image: true` into the catalog without requiring a fake re-toggle.",
        "- Vision auxiliary lists the model after save once projection refreshes.",
        "- Saving a bare Ollama VL model without touching Vision does not stamp `image: false` over runtime name-inference.",
        "- Unknown custom model ids still work via explicit Vision ON + Save; no repo list update is required.",
        "",
        "## Actual",
        "",
        "- Client reference lookup could cross-scan other known-models partitions for display.",
        "- Runtime `model-sync` only used provider partition + generic fallbacks + Ollama infer when catalog fields were absent.",
        "- Model edit Save used dirty-only capability writes, so dictionary-true Vision never entered the catalog until a toggle dirtied the field.",
        "- Capability icons in the added-models list could reflect dictionary merge rather than catalog-saved fields.",
        "",
        "## Local fork fix",
        "",
        "- Align settings reference lookup with server layers when provider is set: provider partition → generic fallbacks only (no cross-provider steal).",
        "- Hybrid capability Save patch: always materialize `true` capabilities; materialize `false` only if the catalog already had that field or the user toggled it.",
        "- Show list capability icons from catalog-saved fields only.",
        "- One-shot stamp of reference defaults into the catalog on custom model add when a provider-scoped/fallback hit exists.",
        "- Invalidate settings config cache after model metadata Save so Vision auxiliary re-reads projection.",
        "- Clarify locale hint: enable Vision and Save; catalog hints may be outdated.",
        "",
        "## Verification",
        "",
        "- Custom provider + known-looking model id: edit → Vision ON → Save once → model appears under Vision auxiliary.",
        "- Bare unknown id: remains text-only until user enables Vision and Saves.",
        "- Bare Ollama VL family id: Save without toggle does not persist `image: false`.",
        "- User turns Vision OFF and Saves: stays off (catalog wins over dictionary).",
        "- Unit tests for `buildCapabilitySavePatch`, catalog-only icons, no cross-provider reference steal, and model-sync user catalog projection.",
      ],
    },
  },
  {
    id: "remote-skill-viewer-local-file-ipc",
    title: "Remote skill viewer reads server-owned skill paths through local Electron IPC",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["pending-local-fix"],
    grouping: "fix: preview remote server skills through active server APIs",
    searches: [
      "remote skill viewer Cannot read file",
      "skills remote SKILL.md file path Electron IPC",
      "remote desktop skill viewer local file path",
    ],
    resultMustInclude: /skill|SKILL|remote|file|path|Electron|IPC|viewer|Cannot read/i,
    notes: [
      "No exact upstream issue found in the 2026-06-30 search.",
      "This draft is based on fork investigate evidence; no local implementation has been committed yet.",
    ],
    draft: {
      file: "remote-skill-viewer-local-file-ipc.md",
      title: "[Bug] Remote skill viewer tries to read server skill files from the desktop filesystem",
      body: [
        "## Summary",
        "",
        "When the desktop app is connected to a remote Hana server, the Skills UI can list skills from the active server but fail to open `SKILL.md` in the preview overlay. The viewer currently receives server-side `baseDir` and `filePath` values from `/api/skills`, then asks Electron IPC to read those paths from the local desktop filesystem.",
        "",
        "That only works when the desktop process and Hana server share the same filesystem. In a LAN/remote-server connection, those paths belong to the remote server, so the local Electron main process cannot read them and the viewer can show `Cannot read file`.",
        "",
        "## Expected",
        "",
        "- Remote skill preview loads the file tree and `SKILL.md` content from the active Hana server.",
        "- Local-owner previews for local skill directories continue to work.",
        "- The server only exposes files rooted inside known skill directories and keeps text/size limits.",
        "- The client does not treat arbitrary absolute paths from a remote server response as local desktop paths.",
        "",
        "## Actual",
        "",
        "- `/api/skills` can return `baseDir` and `filePath` values owned by the active remote server.",
        "- `SkillViewerOverlay` calls `window.hana.listSkillFiles(baseDir)` and `window.hana.readSkillFile(filePath)`.",
        "- Electron main handles those IPC calls by using local `fs.statSync` and `fs.readFileSync`.",
        "- On a remote connection, the local desktop filesystem cannot resolve the server path and preview content is null.",
        "",
        "## Proposed fix",
        "",
        "- Add an authenticated active-server API for skill file tree and text content, keyed by known skill identity/source rather than arbitrary client-supplied absolute paths.",
        "- Use that API for server-owned skill previews in remote connections.",
        "- Keep or adapt the existing Electron IPC path only for local owner paths that are genuinely desktop-visible.",
        "- Add regression coverage with a remote skill whose absolute server path does not exist on the desktop client.",
        "",
        "## Verification",
        "",
        "- Connect the desktop app to a remote Hana server.",
        "- Open Skills and click a listed skill such as `user-guide`.",
        "- Confirm `SKILL.md` and the file tree render without requiring the server path to exist locally.",
      ],
    },
  },
  {
    id: "remote-skill-install-client-local-path",
    title: "Remote skill package installs post client-local paths to the server",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["pending-local-fix"],
    grouping: "fix: upload remote skill packages instead of posting client-local paths",
    searches: [
      "remote skill install local path",
      "desktop skill package install client path remote server",
      "skill package upload remote Hana server path",
    ],
    resultMustInclude: /skill|package|install|upload|remote|server|local path|client path/i,
    notes: [
      "No exact upstream issue found in the 2026-06-30 search.",
      "This is adjacent to remote attachment upload path ownership, but specifically covers skill package installs.",
    ],
    draft: {
      file: "remote-skill-install-client-local-path.md",
      title: "[Bug] Remote skill package install sends desktop-local paths the server cannot read",
      body: [
        "## Summary",
        "",
        "When the desktop app is connected to a remote Hana server, skill package install surfaces can prefer the desktop-local path returned by Electron, then post `{ path: ... }` to `/api/skills/install`. A remote Linux server cannot read a macOS or Windows desktop path, so package install can fail even though the browser `File` bytes are available on the client.",
        "",
        "The server route already supports uploaded package bytes. The UI fallback only uses that upload mode when Electron does not expose a path, which is the wrong decision point for remote connections.",
        "",
        "## Expected",
        "",
        "- In local owner mode, path-based skill install can continue when the server and desktop share filesystem visibility.",
        "- In remote/LAN mode, selected or dropped skill packages upload bytes to the active server instead of sending client-local paths.",
        "- Browse/select and drag/drop install surfaces use the same path ownership rule.",
        "- `.skill` files dropped into chat do not bypass the remote upload path by being intercepted for path-based install first.",
        "",
        "## Actual",
        "",
        "- `SkillsPanel` and Settings -> Skills call `window.platform.getFilePath(file)` and install by `{ path }` whenever it returns a value.",
        "- The base64 upload branch is used only when no local path is available.",
        "- The main chat drop path intercepts `.skill` files and installs by path before the generic remote attachment upload fallback can materialize bytes on the server.",
        "- Remote servers cannot read those client-local desktop paths.",
        "",
        "## Proposed fix",
        "",
        "- Make skill install surfaces connection-aware: use path install only when the active connection can use native resource paths.",
        "- In remote/LAN mode, read the browser file and post `{ file: { filename, contentBase64 } }` to `/api/skills/install`.",
        "- For native path picker APIs that return only a path, either avoid that picker in remote mode or add a safe desktop read-and-upload bridge.",
        "- Add regression tests for remote connection state where `getFilePath(file)` returns a client path but the request body uses uploaded file content.",
        "",
        "## Verification",
        "",
        "- Connect the desktop app to a remote Hana server.",
        "- Drop or select a `.skill` or `.zip` skill package from the desktop client.",
        "- Confirm the install request uploads package bytes and the package is installed on the remote server without requiring the client path to exist server-side.",
      ],
    },
  },
  {
    id: "plugin-iframe-remote-credential-query-leak",
    title: "Remote plugin iframe URL leaks device credential in query token",
    classification: "upstream",
    status: "draft/pending-approval",
    commits: ["7370276c"],
    grouping: "fold into LAN query-token/auth bug fix unless reviewed separately",
    searches: [
      "plugin iframe token credential leak remote",
      "pluginIframeTicket pluginSurfaceSession token",
      "remote plugin iframe device credential query",
    ],
    resultMustInclude: /plugin|iframe|credential|token|pluginIframeTicket|pluginSurfaceSession/i,
    relatedIssues: [
      {
        number: 1493,
        url: "https://github.com/liliMozi/openhanako/issues/1493",
        state: "OPEN",
        relation: "local plugin iframe missing credentials",
      },
      {
        number: 1546,
        url: "https://github.com/liliMozi/openhanako/issues/1546",
        state: "CLOSED",
        relation: "older community plugin iframe load failure",
      },
    ],
    notes: [
      "No exact upstream issue found in the 2026-06-16 search.",
      "This is related to iframe auth, but it is not a duplicate of the local-loopback missing credential issue.",
    ],
    draft: {
      file: "plugin-iframe-remote-credential-query-leak.md",
      title: "[Bug] Remote plugin iframe URLs expose device credentials in query strings",
      body: [
        "## Summary",
        "",
        "After LAN query-token support, the desktop plugin surface URL builder can place the remote device credential into a plugin iframe URL as `token=[REDACTED:device-credential]`. Query strings are visible through browser history, logs, screenshots, and referrer-adjacent tooling, so remote device credentials should not be carried this way.",
        "",
        "## Expected",
        "",
        "- Local owner connections may continue using the local loopback query token path required for iframe loading.",
        "- Remote plugin iframe URLs should use scoped iframe/session credentials such as `pluginIframeTicket` and `pluginSurfaceSession`.",
        "- Remote device credentials should not appear in plugin iframe query strings.",
        "",
        "## Actual",
        "",
        "- Remote plugin iframe URLs can include `token=[REDACTED:device-credential]`.",
        "- The hook already has scoped plugin iframe/session values available, but the generic query-token path can override the safer remote behavior.",
        "",
        "## Related issues",
        "",
        "- #1493 covers missing credentials for local plugin iframe surfaces.",
        "- #1546 is an older plugin iframe loading bug.",
        "- #1749 covers the LAN query-token/CSP/WebSocket regression boundary.",
        "",
        "## Local fork fix",
        "",
        "In `buildPluginSurfaceUrl`, append a query `token` only for `isLocalOwnerConnection(connection)`. Remote plugin iframe URLs keep using the issued plugin iframe ticket/session fields.",
      ],
    },
  },
  {
    id: "local-build-identity-disable-auto-update",
    title: "Local fork builds identify source and disable upstream auto-update",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["d39fae81"],
    grouping: "chore: identify local fork builds and disable local auto-update",
    searches: [],
    notes: [
      "Fork maintenance behavior, not an upstream bug.",
      "Do not draft or submit an upstream issue unless the project later wants an official local-build channel feature.",
    ],
  },
  {
    id: "fork-sync-issue-tracking-prerelease-policy",
    title: "Fork sync tracks upstream issues and ignores prereleases by default",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["f7b26a2f"],
    grouping: "docs: add fork sync policy and upstream issue helper",
    searches: [],
    notes: [
      "Fork maintenance workflow for karlorz/openhanako, not an upstream product bug.",
      "Default sync follows stable upstream releases only; --include-prerelease is explicit candidate review.",
    ],
  },
  {
    id: "fork-dev-loop-maintenance-runbooks",
    title: "Fork dev-loop and sg01 maintenance runbooks",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["e35b4969", "62908b57", "4dd0f429", "fc39a87e"],
    grouping: "docs/chore: dev-loop setup and retired sg01 deploy helper",
    searches: [],
    notes: [
      "Fork operator documentation and local automation hygiene.",
      "The old sg01 SSH deploy helper was intentionally retired in favor of the unified install-server flow.",
    ],
  },
  {
    id: "office-workflow-example-plugin",
    title: "Office workflow example plugin template",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["f14eba54", "4abb9e47"],
    grouping: "examples/plugins: office-workflow template and lint hygiene",
    searches: [],
    notes: [
      "Fork example plugin template and lint cleanup, not an upstream bug.",
      "Keep covered by the plugin SDK example and office-workflow plugin tests during stable syncs.",
    ],
  },
  {
    id: "office-workflow-resourceio-session-permission",
    title: "Office workflow example documents ResourceIO and sessionPermission boundaries",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["v0.341.19-sync"],
    grouping: "examples/plugins: document ResourceIO and sessionPermission boundary",
    searches: [],
    notes: [
      "Fork example documentation follow-up for upstream v0.341.19 SDK contract drift.",
      "Documents when workflow state belongs in ctx.dataDir versus ctx.resources, and requires explicit sessionPermission metadata if the example later adds agent-callable tools.",
    ],
  },
  {
    id: "server-install-upgrade-release-safety",
    title: "Fork server install and upgrade release safety",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: [
      "bf7e0750",
      "628d493c",
      "7ff3ac38",
      "82675262",
      "3039571a",
      "662bf15c",
      "4123c604",
      "74ae705b",
      "80373bcb",
      "b942d866",
      "45c5d651",
      "89488752",
      "7160bacd",
      "f246d977",
      "7cd6c725",
      "84e930d6",
      "306c33d6",
      "c46359d1",
    ],
    grouping: "install-server: verified release assets, safe upgrade, preserved service context",
    searches: [],
    notes: [
      "Fork-only Linux server installer and release packaging flow; upstream v0.323.0 does not ship scripts/install-server.mjs.",
      "Covers release asset selection, sha256 sidecars, checksum verification without shell interpolation, native bundle runners, client assets in server bundles, release-root extraction, metadata-file loading, systemd directive preservation, and upgrade rollback behavior.",
    ],
  },
  {
    id: "server-reinit-data-failsafe",
    title: "Fork server reinit-data failsafe, operational preserve, and restore",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["4204ad27", "c00551da", "03d8c06e", "6a004b3e", "15d27acd"],
    grouping: "install-server: backup-gated reinit-data with operational preserve and latest full-state restore",
    searches: [],
    notes: [
      "Fork-only operational reset/import workflow for first-run and new-user testing on managed Linux server installs.",
      "Covers dry-run planning, backup/confirm/restore flows, provider/device/server-network preserve, studio access preserve, and latest-full-state restore selection.",
    ],
  },
  {
    id: "server-reinit-restore-backup-verification",
    title: "Fork server reinit-data restore verifies backup target before mutation",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["dc8bae99"],
    grouping: "install-server: reject wrong-root restore backups before data-root replacement",
    searches: [],
    notes: [
      "Found during the v0.323.0..dev code review and fixed locally before handoff.",
      "Explicit restore backups now fail verification when the manifest dataRoot differs from the requested data root or the archive omits the expected data-root directory.",
    ],
  },
  {
    id: "node-test-ci-file-mode-hygiene",
    title: "Node test and CI file mode hygiene for fork tooling",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["84a405a3", "7160bacd"],
    grouping: "tests/lint: .mjs node tests, LF enforcement, and eslint coverage",
    searches: [],
    notes: [
      "Fork maintenance for Node ESM test execution and cross-platform line-ending stability.",
      "Included because it protects the fork-only install-server/upstream-issue tooling tests.",
    ],
  },
  {
    id: "legacy-raw-release-profile-evidence",
    title: "Explicit legacy raw fallback profile and release evidence policy",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["pending-local-fix"],
    grouping: "ci/release: explicit signed and legacy-raw fallback with runtime-only server evidence",
    searches: [],
    notes: [
      "Fork release policy, not an upstream product issue.",
      "Tag pushes and attended manual/local commands resolve auto to signed only with validated Ed25519 material, or to marked legacy-raw when both signing inputs are blank.",
      "A release-profile marker allows same-profile reruns and rejects cross-profile or mixed installer uploads before mutation.",
      "Raw releases retain installers, runtime-only server bundles, compatibility metadata, checksums, and the committed digest while excluding updater, train, and mirror assets.",
    ],
  },
  {
    id: "packaged-cli-shared-cjs-externalize",
    title: "Externalize shared/*.cjs from the packaged hana CLI ESM bundle so it loads runtime",
    classification: "fork-only",
    status: "local-verified",
    commits: ["eed8ffc4", "4d67c5bd", "55c867b6", "6c1c8fe9"],
    grouping: "packaging/cli: stage shared artifact-core + externalize CJS-with-builtin-requires from the esbuild ESM CLI bundle",
    searches: [],
    notes: [
      "Fork packaging fix, no upstream issue: the packaged standalone CLI is a fork distribution shape.",
      "Root cause chain (debugged across karlorz.3 -> .7): .3/.4 missing shared/artifact-core/*; .4/.5 missing shared/contract-versions.{cjs,json}; .6 shipped contract-versions.json (55c867b6) and unmasked a deeper failure, 'Dynamic require of crypto is not supported' from the inlined shared/data-epoch.cjs. .7 (6c1c8fe9) externalized shared/data-epoch.cjs, contract-versions.cjs, and server-info-probe.cjs from the esbuild CLI bundle (--format=esm) and staged data-epoch.cjs + server-info-probe.cjs into shared/, so Node's native CJS loader handles their bare require('crypto'/'fs'/'path').",
      "Acceptance: hana --help exits 0 on sg01 at v0.416.51-karlorz.7 and remains green on host line through v0.416.51-karlorz.8; artifact-activation-compatibility + build-server-open suites green; cli-closure-census baseline unchanged.",
      "Check during every upstream release-tag sync that a new shared/*.cjs ESM-imported by the CLI closure and using bare node-builtin requires is either re-externalized here or refactored to a createRequire() pattern (like shared/artifact-core/*).",
    ],
  },
  {
    id: "loopback-trusted-https-proxy-secure-cookies",
    title: "Trust loopback reverse-proxy HTTPS context and optional HANA_SECURE_COOKIES for public Mobile PWA",
    classification: "fork-only",
    status: "local-verified",
    commits: ["1749b830", "c1d26c14", "8345b01a"],
    grouping: "server/auth: inferHttpRequestSecurity + HANA_SECURE_COOKIES for Caddy-terminated HTTPS/WSS Mobile",
    searches: [],
    notes: [
      "Fork deployment shape: public Mobile origin is https://hana.karldigi.dev via Caddy reverse_proxy to 127.0.0.1:14500; Tailscale plain HTTP 100.x:14500 remains a first-class LAN client path.",
      "Code: server/http/transport-context.ts trusts X-Forwarded-Proto: https only from loopback peers (including IPv4-mapped); rejects multi-value/ambiguous forwarding. HANA_SECURE_COOKIES=1 (strict) enables Secure on web-session and plugin asset cookies; wired through open composition + web-auth.",
      "Acceptance on v0.416.51-karlorz.8 / sg01: public HTTPS Mobile 200, WSS 101 via ticket, Secure cookies behind Caddy, direct :14500 spoof of X-Forwarded-Proto rejected, Playwright mobile UAT D1.8/D1.9 PASS under operator browser boundary (physical install/OS lifecycle deferred non-blocking).",
      "Ops: docs/ops/sg01-https-caddy-14500-boundary.md (OCI public 14500 boundary, DNS-only Cloudflare decision). Do not bind loopback-only while Tailscale clients use :14500.",
    ],
  },
  {
    id: "data-epoch-windows-fail-closed-timeout",
    title: "Raise Vitest timeout for data-epoch fail-closed interruption loop on Windows CI",
    classification: "fork-only",
    status: "local-verified",
    commits: ["d656c7af"],
    grouping: "tests/ci: Windows PR dashboard flake on multi-fault data-epoch coordinator loop",
    searches: [],
    notes: [
      "PR #1 dashboard CI run 30232229820 failed only on windows-latest: tests/data-epoch-coordinator.test.ts fail-closed interruption it hit the default 10s budget while the same tip push CI Windows job passed.",
      "Fix: per-test timeout raise for the long serial fault-injection loop (not a product contract change).",
      "Acceptance: subsequent dev push and PR #1 CI green including windows-latest.",
    ],
  },
  {
    id: "sg01-public-https-caddy-ops-docs",
    title: "Document sg01 Caddy HTTPS topology, OCI 14500 boundary, and CF DNS-only policy",
    classification: "fork-only",
    status: "tracked/no-upstream-issue",
    commits: ["ad5fd20a"],
    grouping: "docs/ops: sg01 HTTPS/Caddy/14500 boundary and Cloudflare DNS-only decision",
    searches: [],
    notes: [
      "Fork host runbook only: docs/ops/sg01-https-caddy-14500-boundary.md plus pointer from docs/server-install.md.",
      "Records topology (Caddy, Tailscale, OCI), D2.2 public-14500 investigation, D2.4 gray-cloud decision, and verification commands without secrets.",
    ],
  },
];

export function markdownTable(rows) {
  const lines = [
    "| fix | classification | status | upstream | grouping |",
    "|---|---|---|---|---|",
  ];
  for (const fix of rows) {
    const upstreamIssues = [
      ...(fix.existingIssue ? [fix.existingIssue] : []),
      ...(fix.relatedIssues ?? []),
    ];
    const upstream = upstreamIssues.length
      ? upstreamIssues
        .map((issue) => `[#${issue.number}](${issue.url})${issue.state ? ` ${issue.state}` : ""}`)
        .join(", ")
      : "none";
    lines.push(
      `| ${escapeCell(fix.id)} | ${escapeCell(fix.classification)} | ${escapeCell(fix.status)} | ${upstream} | ${escapeCell(fix.grouping)} |`,
    );
  }
  return lines.join("\n");
}

export function renderStatusMarkdown(rows = TRACKED_FIXES) {
  return [
    "# Upstream Issue Tracking",
    "",
    "This file tracks local fork fixes against upstream GitHub issues. The source of truth for the tracked fix list is `scripts/track-upstream-issues.mjs`.",
    "",
    markdownTable(rows),
    "",
    "## Rules",
    "",
    "- Track every local fix or maintenance slice.",
    "- Search upstream for every `upstream` or `needs-triage` item.",
    "- Keep `fork-only` items documented without upstream issue noise.",
    "- Draft issue bodies locally first. Codex and Claude never submit them; human review changes wording only.",
    "- Only a human acting manually outside an agent session may publish an approved draft.",
    "- Do not store live credentials, tokens, cookies, or server secrets in drafts.",
    "",
    "## Commands",
    "",
    "```bash",
    "node scripts/track-upstream-issues.mjs status",
    "node scripts/track-upstream-issues.mjs search",
    "node scripts/track-upstream-issues.mjs draft",
    "```",
    "",
  ].join("\n");
}

export function renderDraftIssue(fix) {
  if (!fix.draft) {
    throw new Error(`${fix.id} does not have a draft issue`);
  }
  const related = [
    ...(fix.existingIssue ? [fix.existingIssue] : []),
    ...(fix.relatedIssues ?? []),
  ];
  return [
    `# ${fix.draft.title}`,
    "",
    "> Local draft only. Codex and Claude must never submit, comment, edit, label, react, close, or otherwise publish this upstream. Human approval changes the draft wording state only; a human must post manually outside the agent session.",
    "",
    `Tracked fix: \`${fix.id}\``,
    `Classification: \`${fix.classification}\``,
    `Current status: \`${fix.status}\``,
    `Suggested grouping: \`${fix.grouping}\``,
    `Commits: ${fix.commits.map((commit) => `\`${commit}\``).join(", ")}`,
    "",
    ...(related.length
      ? [
          "Related upstream issues:",
          "",
          ...related.map((issue) => `- #${issue.number}: ${issue.url}`),
          "",
        ]
      : []),
    ...fix.draft.body,
    "",
  ].join("\n");
}

export function writeDrafts(rows = TRACKED_FIXES) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const written = [];
  for (const fix of rows) {
    if (!fix.draft) continue;
    const outPath = path.join(DRAFTS_DIR, fix.draft.file);
    fs.writeFileSync(outPath, renderDraftIssue(fix), "utf8");
    written.push(outPath);
  }
  return written;
}

export function writeReadme(rows = TRACKED_FIXES) {
  fs.mkdirSync(ISSUE_DOCS_DIR, { recursive: true });
  const outPath = path.join(ISSUE_DOCS_DIR, "README.md");
  fs.writeFileSync(outPath, renderStatusMarkdown(rows), "utf8");
  return outPath;
}

export function searchableFixes(rows = TRACKED_FIXES) {
  return rows.filter((fix) => fix.classification !== "fork-only" && fix.searches.length > 0);
}

export function runGhIssueSearch(query, repo = UPSTREAM_REPO) {
  const output = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--search",
      query,
      "--state",
      "all",
      "--json",
      "number,title,state,url,labels",
      "--limit",
      "10",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

export function collectSearchResults(rows = TRACKED_FIXES) {
  return searchableFixes(rows).map((fix) => ({
    id: fix.id,
    queries: fix.searches.map((query) => ({
      query,
      results: filterIssueResults(fix, runGhIssueSearch(query)),
    })),
  }));
}

export function filterIssueResults(fix, results) {
  if (!fix.resultMustInclude) return results;
  return results.filter((issue) => fix.resultMustInclude.test(`${issue.title} ${issue.url}`));
}

export function renderSearchResults(results) {
  const lines = ["# Upstream Issue Search Results", ""];
  for (const fix of results) {
    lines.push(`## ${fix.id}`, "");
    for (const query of fix.queries) {
      lines.push(`Query: \`${query.query}\``);
      if (!query.results.length) {
        lines.push("", "- No results.", "");
        continue;
      }
      lines.push("");
      for (const issue of query.results) {
        lines.push(`- #${issue.number} ${issue.state}: ${issue.title} (${issue.url})`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printHelp() {
  console.log(`Usage: node scripts/track-upstream-issues.mjs <command>

Commands:
  status   Print the tracked local-fix issue table
  search   Query upstream issues with gh and print matches
  draft    Write docs/upstream-issues/README.md and local draft issue files

This script never creates, comments on, edits, labels, reacts to, closes, or otherwise mutates upstream issues. Drafts are local files only; only a human may post them manually outside an agent session.`);
}

function main(argv) {
  const command = argv[2] ?? "status";
  if (command === "status") {
    console.log(renderStatusMarkdown().trimEnd());
    return;
  }
  if (command === "search") {
    console.log(renderSearchResults(collectSearchResults()).trimEnd());
    return;
  }
  if (command === "draft") {
    const readme = writeReadme();
    const drafts = writeDrafts();
    console.log(`Wrote ${path.relative(ROOT, readme)}`);
    for (const draft of drafts) {
      console.log(`Wrote ${path.relative(ROOT, draft)}`);
    }
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
