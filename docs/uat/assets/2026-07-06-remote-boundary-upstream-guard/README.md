# UAT Screenshot Assets

Human-review screenshots for `docs/uat/2026-07-06-remote-boundary-upstream-guard-uat.md` are stored in this directory.

## Primary Checklist Screenshots

- `01-valid-remote-access-tab.png` — valid sg01 Remote Server state in Settings -> Access.
- `02-recovery-gated-shell.png` — pre-2026-07-07 recovery-only app shell for missing required boundary capability. This asset also documents the raw i18n-key bug and should be superseded after the recovery i18n fix is installed.
- `03-inline-boundary-error.png` — pre-2026-07-07 invalid retry stays inline and does not reload-loop. This asset also documents the raw i18n-key bug and should be superseded after the recovery i18n fix is installed.
- `04-connect-another-cleared-form.png` — Settings -> Access clears URL/key for a new Remote Server.
- `05-key-remasked-after-value-change.png` — revealed key returns to password mode after parent value replacement.
- `06-auth-failed-reason.png` — rejected credential maps to `auth_failed`.
- `07-onboarding-key-row.png` — onboarding URL/key rows align and Show toggle is inside the key row.
- `08-remote-image-preview.png` — live sg01 image upload/send/switch-return shows the generated PNG in chat and Conversation Files.

## Screen Recordings And Probe Evidence

- `run-20260706-222135/probe-screen.png`
- `run-20260706-222135/probe-recording.mov`
- `run-20260706-222135/01-hanaagent-remote-connected.png`
- `run-20260706-222135/01-hanaagent-remote-connected.mov`
- `run-20260706-222135/01-valid-remote-access-tab.mov`
- `run-20260706-222135/02-recovery-gated-shell.mov`
- `run-20260706-222135/03-inline-boundary-error.mov`
- `run-20260706-222135/04-connect-another-cleared-form.mov`
- `run-20260706-222135/05-key-remasked-after-value-change.mov`
- `run-20260706-222135/06-auth-failed-reason.mov`
- `run-20260706-222135/07-onboarding-key-row.mov`

Row 8 was completed after the recording batch by attaching and sending a generated non-sensitive PNG through the packaged app, switching away to another chat, returning to `Image Preview Smoke Test`, and capturing the restored image/file preview state.

## 2026-07-07 Follow-up Evidence

The 2026-07-07 recovery i18n follow-up keeps `02-recovery-gated-shell.png` and `03-inline-boundary-error.png` as before-fix evidence. Those two screenshots intentionally show the raw-key bug. Use these successor artifacts for the fixed packaged-app UAT state:

- `run-20260707-followup/09-recovery-localized.png` — missing required boundary capability still gates the app body, but the recovery panel now shows localized English user copy.
- `run-20260707-followup/10-inline-retry-localized.png` — invalid retry remains inline as `connect probe failed: login HTTP 403`, with localized surrounding recovery labels/buttons and no reload loop.
- `run-20260707-followup/11-settings-access-open-onboarding.png` — local-owner Settings -> Access shows the localized Onboarding shortcut section in the Access tab. This screenshot is from the Korean locale pass.
- `run-20260707-followup/12-open-onboarding-window.png` — clicking the Settings shortcut opens the packaged Electron onboarding window.
- `run-20260707-followup/13-locale-coverage.json` — CDP evidence for English, Simplified Chinese, Traditional Chinese, Japanese, and Korean recovery-screen and Settings-shortcut checks. Each locale has an empty raw-key match list.
