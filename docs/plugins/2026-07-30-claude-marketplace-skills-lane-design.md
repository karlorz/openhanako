# Design: Claude Code marketplace browse + skills-lane install (Hana)

**Date:** 2026-07-30  
**Status:** draft for human review (not yet implemented under this doc)  
**Branch context:** `dev` (karlorz/openhanako)  
**Related:** multi-source marketplace Approach 1 (`2026-07-29-native-multi-marketplace-support`), `lib/plugin-marketplace-detect.ts` (catalog detect only)

## 1. Problem statement

Operators want Hana to work with **Claude Code–shaped marketplaces** such as `https://github.com/karlorz/llm-wiki` (catalog at `.claude-plugin/marketplace.json`, packages with relative `source` trees of `SKILL.md` skills).

### Observed failure (2026-07-30 screenshot)

Settings → Plugins → Add source (git, `llm-wiki`, URL filled) still surfaces:

```text
Plugin "marketplace" not found
```

That string is produced by the **plugin route catch-all** when `pluginId === "marketplace"` and the multi-source host routes are **not** handling the request (old server / wrong connection). It is **not** a Claude catalog parse error.

Local probe on a multi-source build (`127.0.0.1:14500`, v0.421.24):

| Call | Result |
|------|--------|
| `GET /api/plugins/marketplace/sources` | 200 (route present) |
| `POST …/sources` (no studio.owner) | 403 `studio.owner required` (route present) |

So: **host/connection/owner messaging** and **true Claude install** must both be designed; catalog auto-detect alone is insufficient.

### What was already proven (narrow)

- Pure URL normalize + index probe + Claude→tagged row map (fixtures + one live Node `addSource` for llm-wiki).
- **Not** proven: Electron Settings → active connection → add source → install skills.

### Success bar (approved: P2 + Approach A)

1. Browse Claude marketplace catalogs in Hana multi-source UI/API.  
2. Install Claude plugin packages as **Hana user/agent skills** (skills-lane), not as deep Hana runtime plugins.  
3. Prove end-to-end on **local** connection for `https://github.com/karlorz/llm-wiki` → catalog `skillwiki` + `vault-sync` → install skills from relative package trees.

## 2. Goals and non-goals

### Goals

- **Host reliability:** Settings marketplace sources never surfaces catch-all `Plugin "marketplace" not found` for multi-source APIs; clear errors for “server too old”, “wrong connection”, “studio.owner required”.
- **Catalog:** Auto-detect `.claude-plugin/marketplace.json`; parse Claude shape without weakening Hana `schemaVersion: 1` strict catalogs.
- **Install (v1):** Relative Claude `source` packages → discover `SKILL.md` trees → install via existing skill package installer path; record provenance `pluginId@marketplaceId`.
- **UX:** Install action labeled for skills; non-installable Claude object sources show why.

### Non-goals (v1)

- Treating Claude packages as Hana deep plugins (`distribution.kind: "release"` zip + plugin manager runtime).
- Claude **agents**, **hooks**, **MCP**, or CLI binaries as first-class Hana plugin contributions.
- Private/SSH git markets; authenticated git.
- Replacing OH-Plugins official authority.
- Auto-deploy to sg01; permanent draft PR #1 policy unchanged.
- Full Anthropic object-source matrix (`git-subdir` / npm / github fetch) for **install** (browse may list them as non-installable).

## 3. Architecture (Approach A — skills-lane importer)

```
Settings renderer
  → hanaFetch(active connection)
Server multi-source APIs
  → acquire (git normalize + index probe + Hana|Claude parse)
  → snapshot / catalog rows
  → install:
       Hana release zip → existing plugin install
       Claude relative package → skills importer → SkillPackageInstaller
```

### Identity

| Concept | Rule |
|---------|------|
| Marketplace id | Operator-registered (e.g. `llm-wiki`) |
| Catalog composite | `pluginId@marketplaceId` |
| Installed skills | Hana skill names from `SKILL.md` frontmatter / dir sanitize |
| Provenance | Install record links skills → `pluginId@marketplaceId` + git revision when available |

### Module boundaries

| Module | Responsibility |
|--------|----------------|
| `plugin-marketplace-detect.ts` | URL normalize, index candidates, Claude/Hana catalog auto-parse (browse) |
| `plugin-marketplace-git-cache.ts` | Clone/show; extended sparse checkout for **package trees** on install |
| `plugin-marketplace-service.ts` | Orchestrate add/refresh/list; dispatch install |
| **New** Claude skills importer (name under `lib/`) | Materialize relative package + multi-skill install + provenance |
| `lib/skills/skill-package-installer.ts` | Reuse existing SKILL.md install primitives |
| `server/routes/plugins.ts` | Host routes; install branch; never catch-all host ids |
| `MarketplaceSourcesPanel` + marketplace catalog UI | Errors, add source, install skills CTA |

## 4. Data model

### 4.1 Catalog row extensions (Claude)

| Field | Value |
|-------|--------|
| `install.catalogFormat` | `"claude"` |
| `install.source` | normalized relative path or object summary |
| `install.sourceKind` | `"relative"` \| `"git-subdir"` \| `"github"` \| `"unsupported"` |
| `install.installTarget` | `"skills"` |
| `install.canInstall` | true only for materializable v1 sources (relative) |
| `distribution` | `null` (must not claim Hana release integrity) |
| `trust` | `restricted` |

Hana native rows remain strict `schemaVersion: 1` with release/source distribution rules unchanged.

### 4.2 Provenance store

Prefer extending install records with a distinct kind, e.g.:

```json
{
  "kind": "claude-skills",
  "pluginId": "skillwiki",
  "marketplaceId": "llm-wiki",
  "resolvedRevision": "<git sha>",
  "packagePath": "packages/skills",
  "skills": ["wiki-query", "wiki-ingest", "..."],
  "installedAt": "<iso>"
}
```

If plugin-install-records cannot express this cleanly, use a dedicated file under marketplace state path segments (`buildMarketplaceStatePathSegments`).

## 5. Flows

### 5.1 Add git marketplace source

1. UI posts `{ id, name, kind: "git", gitUrl, gitRef?, indexPath? }` to `POST /api/plugins/marketplace/sources`.
2. Server requires studio.owner (local kind also requires local-owner).
3. Normalize git URL (bare repo, `.git`, GitHub `/tree|blob/...`).
4. Shallow clone; probe index candidates: configured/default `marketplace.json`, then `.claude-plugin/marketplace.json`.
5. Parse via auto (Hana strict if `schemaVersion: 1`, else Claude shape).
6. Publish snapshot; register source; return sources list + status `ok` | error with safe message.

**Error mapping (UI):**

| Server symptom | User-facing |
|----------------|-------------|
| Catch-all / missing multi-source routes | “This Hana server does not support multi-source marketplaces… use local multi-market build or upgrade remote.” |
| 403 studio.owner | “Studio owner required to add marketplace sources on this connection.” |
| Index not found / invalid Claude | Specific acquisition error (sanitized) |

### 5.2 Install Claude plugin as skills (v1 relative only)

Request: `POST /api/plugins/marketplace/:pluginId/install` with `marketplaceId`.

1. Resolve row from snapshot; require `install.catalogFormat === "claude"` and `sourceKind === "relative"` and `canInstall`.
2. Materialize package tree from git cache (sparse checkout of `install.source` under clone root; path-safe).
3. Resolve skill roots:
   - Read package `.claude-plugin/plugin.json` or package-local `plugin.json` `skills` field if present;
   - else walk for directories containing `SKILL.md`.
4. Install each skill via existing skill package installer (sanitize names; define overwrite policy: fail on conflict unless `force` or matching provenance).
5. Write provenance; return installed skill list.

**llm-wiki:**

- `skillwiki` → `packages/skills`
- `vault-sync` → `packages/vault-sync`

### 5.3 Hana native install

Unchanged release-zip path when row is not Claude.

## 6. API / UI surface

| Endpoint | Notes |
|----------|--------|
| `GET/POST /api/plugins/marketplace/sources` | Host-owned; never plugin proxy |
| `DELETE/POST …/sources/:id[/refresh]` | Host-owned |
| `GET /api/plugins/marketplace/catalog` | Expose `canInstall`, `installTarget` for Claude rows |
| `POST /api/plugins/marketplace/:id/install` | Branch Claude vs Hana |

UI:

- Marketplace sources panel: map host errors on **load and add**.
- Catalog/install: “Install skills” when `installTarget === "skills"`.
- After install: toast count; skills visible under Skills settings.

## 7. Testing & verification plan

### Automated (gating)

1. **Host routes:** POST/GET sources never return `Plugin "marketplace" not found` when multi-source router is mounted; host-id set includes `marketplace`.
2. **Detect:** existing Claude detect suite + object-source browse classification (`canInstall: false`).
3. **Importer:** fixture repo layout (marketplace.json Claude + package with multiple `SKILL.md`) drives **shipped** materialize + install entry; asserts skill files land under expected skills root and provenance written.
4. **Regression:** Hana `schemaVersion: 1` catalog parse + release install path still green.
5. `npm run typecheck`, `git diff --check`.

### Manual / evidence (gating for claim “works in app”)

1. Local `install:local` + force re-activate renderer/server artifacts (same-version seed trap).
2. Ensure desktop **local** connection (not stale remote without multi-source).
3. Settings → Plugins → add git `https://github.com/karlorz/llm-wiki` → status ok.
4. Catalog shows skillwiki + vault-sync.
5. Install skillwiki → skills appear / loadable.
6. Optional: remote too-old still shows upgrade message, not catch-all.

### Non-gating

- Live network git (record honestly if blocked).
- Official Anthropic full catalog install.

## 8. Implementation phases

| Phase | Deliverable | Exit |
|-------|-------------|------|
| **0 Host** | Error mapping on add; connection guidance; confirm local e2e add without catch-all toast | Screenshot / API log on local |
| **1 Catalog harden** | Relative Claude browse complete; `canInstall` / `installTarget` on catalog API | Tests + listCatalogRows |
| **2 Skills install** | Relative materialize + multi-SKILL install + provenance | Fixture tests + local install skillwiki |
| **3 Polish** | UI copy, docs (PLUGINS / skill creator note), follow-ups for git-subdir install | typecheck + check |

## 9. Risks and follow-ups

| Risk | Mitigation |
|------|------------|
| Operator on remote without multi-source | Explicit UI; no silent catch-all |
| Claude package has agents/hooks/CLI only | Install only SKILL.md trees; document ignored components |
| Skill name collisions | Clear conflict error; optional force |
| Git cache only stored marketplace.json blob | Install must checkout package path |
| Scope creep to full Anthropic matrix | v1 relative-only install; object sources browse-only |

**Follow-ups (explicitly deferred):**

- Install for `git-subdir` / github object sources  
- Claude agents/hooks/MCP mapping  
- Deep Hana plugin runtime for Claude packages  
- Boot-seed official snapshot / remote upgrade of sg01  

## 10. Decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Product bar | P2 browse + install skills | User 2026-07-30 |
| Approach | A skills-lane importer | Reuses skill installer; avoids fake deep plugins |
| v1 install sources | Relative paths only | llm-wiki ships this; object fetch is larger |
| Host vs Claude | Fix host messaging as Phase 0 | Screenshot failure is host/connection shaped |

## 11. Approval

Architecture §1, data/install §2, and testing/rollout §3 approved in session before this document was written. **Human review of this file is required before implementation plan / coding under this design.**
