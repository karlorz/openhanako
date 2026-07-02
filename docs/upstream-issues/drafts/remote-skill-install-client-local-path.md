# [Bug] Remote skill package install sends desktop-local paths the server cannot read

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `remote-skill-install-client-local-path`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: upload remote skill packages instead of posting client-local paths`
Commits: `pending-local-fix`

## Summary

When the desktop app is connected to a remote Hana server, skill package install surfaces can prefer the desktop-local path returned by Electron, then post `{ path: ... }` to `/api/skills/install`. A remote Linux server cannot read a macOS or Windows desktop path, so package install can fail even though the browser `File` bytes are available on the client.

The server route already supports uploaded package bytes. The UI fallback only uses that upload mode when Electron does not expose a path, which is the wrong decision point for remote connections.

## Expected

- In local owner mode, path-based skill install can continue when the server and desktop share filesystem visibility.
- In remote/LAN mode, selected or dropped skill packages upload bytes to the active server instead of sending client-local paths.
- Browse/select and drag/drop install surfaces use the same path ownership rule.
- `.skill` files dropped into chat do not bypass the remote upload path by being intercepted for path-based install first.

## Actual

- `SkillsPanel` and Settings -> Skills call `window.platform.getFilePath(file)` and install by `{ path }` whenever it returns a value.
- The base64 upload branch is used only when no local path is available.
- The main chat drop path intercepts `.skill` files and installs by path before the generic remote attachment upload fallback can materialize bytes on the server.
- Remote servers cannot read those client-local desktop paths.

## Proposed fix

- Make skill install surfaces connection-aware: use path install only when the active connection can use native resource paths.
- In remote/LAN mode, read the browser file and post `{ file: { filename, contentBase64 } }` to `/api/skills/install`.
- For native path picker APIs that return only a path, either avoid that picker in remote mode or add a safe desktop read-and-upload bridge.
- Add regression tests for remote connection state where `getFilePath(file)` returns a client path but the request body uses uploaded file content.

## Verification

- Connect the desktop app to a remote Hana server.
- Drop or select a `.skill` or `.zip` skill package from the desktop client.
- Confirm the install request uploads package bytes and the package is installed on the remote server without requiring the client path to exist server-side.
