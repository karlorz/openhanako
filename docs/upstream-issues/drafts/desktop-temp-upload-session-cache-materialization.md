# [Bug] Desktop temp upload attachments can outlive their source temp files

> Local draft only. Do not submit upstream until the fork owner approves.

Tracked fix: `desktop-temp-upload-session-cache-materialization`
Classification: `upstream`
Current status: `draft/pending-approval`
Suggested grouping: `fix: materialize temp uploads to session cache before send`
Commits: `ce498f68`

## Summary

Desktop upload flows can pass display attachments backed by temporary upload paths. If those paths are later cleaned up or are not stable for the session lifecycle, message attachment previews and prompt file references can point at files that no longer exist.

## Expected

- Files selected or pasted through desktop upload flows are copied into the session-owned cache before send.
- Display attachment paths and session file refs point at stable session-cache paths.
- The original temp upload path is not required after the message is submitted.
- Materialization refuses symlink sources and avoids clobbering existing cached files.

## Actual

- A display attachment can retain its original temp upload path.
- Later cleanup of the temp location can break preview rendering or downstream file reference resolution.

## Local fork fix

- Copy temp upload display attachments into the session-files cache during desktop session submission.
- Use exclusive copies and a bounded unique-name loop to avoid overwriting existing files.
- Reject symlink temp upload sources and fall back to the original path on materialization failure so sending does not regress.
