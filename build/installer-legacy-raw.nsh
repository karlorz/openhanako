; Profile-specific NSIS entrypoint for the legacy-raw desktop package.
; Keep the common overlay/uninstall logic in installer.nsh and only switch the
; compile-time install-surface branch here.
!define HANA_RELEASE_PROFILE_LEGACY_RAW
!include "installer.nsh"
