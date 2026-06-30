# [Bug] Remote skill viewer tries to read server skill files from the desktop filesystem

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `remote-skill-viewer-local-file-ipc`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: preview remote server skills through active server APIs`
Commits: `pending-local-fix`

## Summary

When the desktop app is connected to a remote Hana server, the Skills UI can list skills from the active server but fail to open `SKILL.md` in the preview overlay. The viewer currently receives server-side `baseDir` and `filePath` values from `/api/skills`, then asks Electron IPC to read those paths from the local desktop filesystem.

That only works when the desktop process and Hana server share the same filesystem. In a LAN/remote-server connection, those paths belong to the remote server, so the local Electron main process cannot read them and the viewer can show `Cannot read file`.

## Expected

- Remote skill preview loads the file tree and `SKILL.md` content from the active Hana server.
- Local-owner previews for local skill directories continue to work.
- The server only exposes files rooted inside known skill directories and keeps text/size limits.
- The client does not treat arbitrary absolute paths from a remote server response as local desktop paths.

## Actual

- `/api/skills` can return `baseDir` and `filePath` values owned by the active remote server.
- `SkillViewerOverlay` calls `window.hana.listSkillFiles(baseDir)` and `window.hana.readSkillFile(filePath)`.
- Electron main handles those IPC calls by using local `fs.statSync` and `fs.readFileSync`.
- On a remote connection, the local desktop filesystem cannot resolve the server path and preview content is null.

## Proposed fix

- Add an authenticated active-server API for skill file tree and text content, keyed by known skill identity/source rather than arbitrary client-supplied absolute paths.
- Use that API for server-owned skill previews in remote connections.
- Keep or adapt the existing Electron IPC path only for local owner paths that are genuinely desktop-visible.
- Add regression coverage with a remote skill whose absolute server path does not exist on the desktop client.

## Verification

- Connect the desktop app to a remote Hana server.
- Open Skills and click a listed skill such as `user-guide`.
- Confirm `SKILL.md` and the file tree render without requiring the server path to exist locally.
