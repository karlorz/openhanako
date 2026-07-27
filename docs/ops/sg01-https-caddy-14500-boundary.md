# sg01 public HTTPS, Caddy, and port 14500 boundary

Status: operational notes for the fork deployment on **sg01** after
`v0.416.51-karlorz.8` Track D (Mobile HTTPS/WSS via Caddy).

**Do not put secrets, cookies, device keys, or private keys in this file.**

---

## Topology (current)

| Path | Role |
|---|---|
| `https://hana.karldigi.dev` | Public Mobile/PWA origin (Caddy TLS, Let's Encrypt) |
| `http://hana.karldigi.dev` | Redirects to HTTPS (308) |
| Caddy `reverse_proxy 127.0.0.1:14500` | Local-only hop to HanaAgent |
| HanaAgent `0.0.0.0:14500` | App listen (LAN mode); **not** public TLS |
| `http://100.125.173.118:14500` | Tailscale direct access (desktop / LAN tooling) |
| Public IPv4 `161.118.205.111` | DNS A for `hana.karldigi.dev` (OCI public IP) |
| Private VNIC `10.0.0.222/24` on `enp0s6` | OCI VCN primary interface |

Related host config (no secrets):

- systemd drop-in: `/etc/systemd/system/hanaagent.service.d/https.conf`  
  → `Environment=HANA_SECURE_COOKIES=1`
- Caddy site block (among other `*.karldigi.dev` sites):

```caddy
hana.karldigi.dev {
	reverse_proxy 127.0.0.1:14500
}
```

- `/etc/hanaagent/server-network.json`: **absent** (default bind; do not invent a bind change without consumers review)

App security relevant to the public path:

- `X-Forwarded-Proto: https` is trusted only from **loopback** peers
  (`127.0.0.1` / `::1` / IPv4-mapped loopback).
- Direct `:14500` clients cannot spoof HTTPS for Secure cookies
  (`password_login_requires_secure_context` when forced).

---

## Cloud provider

sg01 is an **Oracle Cloud Infrastructure (OCI)** instance:

- Region: `ap-singapore-1`
- Shape: `VM.Standard.A1.Flex` (arm64)
- Primary VNIC: private `10.0.0.222` in subnet `10.0.0.0/24`
- Public IP observed: `161.118.205.111` (ephemeral/public mapping in front of the private VNIC)

Internet ingress is therefore governed first by **OCI networking** (VCN
**security lists** and/or **network security groups**), then by the host
firewall. Host metadata alone does not list the security-list contents; those
live in the OCI console / API under the VCN attached to the instance VNIC.

---

## D2.2 investigation results (2026-07-27)

### Probes

| Probe | Result |
|---|---|
| `https://hana.karldigi.dev/mobile/` | HTTP **200** |
| `http://hana.karldigi.dev/mobile/` | HTTP **308** → HTTPS |
| `http://100.125.173.118:14500/mobile/` (Tailscale) | HTTP **200** |
| `http://127.0.0.1:14500/mobile/` (on host) | HTTP **200** |
| `http://10.0.0.222:14500/mobile/` (VCN private IP, on host) | HTTP **200** |
| `http://161.118.205.111:14500/mobile/` (public IP, external) | **Timeout** |
| Same public-IP probe **from the host itself** | **Timeout** (no useful hairpin; consistent with no public mapping for 14500) |

### Host firewall

- Implementation: **iptables-nft**, rules dominated by **Tailscale** (`ts-input` / `ts-forward`).
- `INPUT` policy: **ACCEPT**.
- No host rule specifically targeting TCP/14500.
- Tailscale chain accepts `iifname tailscale0` and drops spoofed CGNAT sources off-path; it does **not** block public-interface 14500.

### Listener consumers

- Hana listens on **`0.0.0.0:14500`** (all interfaces).
- Active product requirement: preserve Tailscale consumer path  
  `100.x → 100.125.173.118:14500` (established desktop/LAN smoke).
- Caddy reaches the app only via **loopback**.

### Conclusion

| Layer | TCP/14500 from the public Internet |
|---|---|
| OCI security list / NSG (inferred) | **Blocked or unmapped** — external probes time out while 80/443 work |
| Host nftables | **Not blocking** — would allow 14500 if a packet reached the VNIC |
| Application bind | **Open on all interfaces** — intentional for Tailscale |

**D2.2 decision (2026-07-27):** treat public exposure of 14500 as **already denied at the OCI boundary**. Do **not**:

1. Bind HanaAgent to `127.0.0.1` only (would break Tailscale desktop clients).
2. Add a host DROP for all sources on 14500 (would also risk Tailscale unless carefully interface-scoped).

**Optional defense-in-depth (not applied):** a narrow host rule that drops
TCP/14500 only on the public/VCN NIC, for example:

```text
# CONCEPT ONLY — do not apply without attended review and Tailscale re-smoke
# nft add rule inet filter input iifname "enp0s6" tcp dport 14500 drop
```

Prefer confirming and locking the **OCI security list / NSG** so internet
ingress allows **80/443 only** (plus whatever admin SSH path you already use),
and **never** 14500 from `0.0.0.0/0`.

### Residual risks (accepted / documented)

1. **Same-VCN private path:** hosts that can reach `10.0.0.222:14500` on the
   private subnet still get plain HTTP Hana (probe from the instance succeeded).
   That is VCN-east-west, not the public Internet.
2. **Host INPUT ACCEPT:** if OCI rules are ever opened for 14500 by mistake,
   the host will not stop the traffic.
3. **No OCI API verification in-repo:** security-list contents were **not**
   dumped via `oci` CLI (no CLI/config in this investigation path). Console
   confirmation remains a human step (checklist below).

---

## OCI console checklist (attended, ~5 minutes)

In OCI Console → Networking → Virtual Cloud Networks → (sg01 VCN) →  
Security Lists **and** Network Security Groups attached to the instance VNIC:

| Ingress | Source | Dest port | Expected for public Hana |
|---|---|---|---|
| Allow | `0.0.0.0/0` | TCP **80** | Yes (ACME / HTTP redirect) |
| Allow | `0.0.0.0/0` | TCP **443** | Yes (public HTTPS) |
| Allow | `0.0.0.0/0` | TCP **14500** | **No — remove if present** |
| Allow | admin CIDR / bastion | TCP **22** | Optional / operator policy |
| Stateful egress | as today | — | Unchanged unless debugging |

Also confirm the public IP assignment still points at the same VNIC after
reboots/recreates (DNS A for `hana.karldigi.dev` must match).

After any NSG/security-list edit:

```bash
# From a network outside Tailscale / outside the VCN:
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 8 https://hana.karldigi.dev/mobile/
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 6 http://161.118.205.111:14500/mobile/ || echo "timeout-expected"

# From a Tailscale client:
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 6 http://100.125.173.118:14500/mobile/
```

Expected: HTTPS **200**, public 14500 **timeout/fail**, Tailscale 14500 **200**.

---

## Caddy / cert operations (no secrets)

### Site file

- Config: `/etc/caddy/Caddyfile`
- Backup pattern used during Track D:  
  `/etc/caddy/Caddyfile.backup-<UTC timestamp>`
- Validate with the **Caddyfile adapter** (suffixless temps may parse as JSON and fail):

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

### DNS

- A record: `hana.karldigi.dev` → public IP of sg01 (currently `161.118.205.111`).
- Initial cert issuance used public ACME (TLS-ALPN-01 observed).
- **Current mode (2026-07-27):** DNS answers with the origin public IP and
  responses show `via: 1.1 Caddy` with **no** `cf-ray` header — i.e.
  **DNS-only / gray-cloud** (not Cloudflare-proxied).

### Secure cookies

```bash
# drop-in already on host after Track D
systemctl cat hanaagent | grep -i HANA_SECURE_COOKIES || true
# expect Environment=HANA_SECURE_COOKIES=1
```

Strict semantics in app code: only the value `1` enables Secure cookies;
unset/`0`/`true` leave them disabled.

### Upgrade path

Use only:

```bash
# plan first
node scripts/install-server.mjs upgrade --version v0.416.51-karlorz.N --channel prerelease --dry-run
# then attended execute on host via install-server
```

See `docs/server-install.md`. Do not revive the retired SSH deploy helper.

---

## D2.4 — Cloudflare proxied mode (decision)

### Decision (2026-07-27)

**Keep DNS-only (gray cloud) for v1.** Do **not** enable Cloudflare orange-cloud
proxy for `hana.karldigi.dev` unless there is a concrete WAF/DDoS need later.

### Why DNS-only now

| Factor | DNS-only (current) | Orange-cloud proxy |
|---|---|---|
| ACME on origin Caddy | Works today (TLS-ALPN-01 / HTTP-01 to origin) | Often breaks origin LE unless SSL mode and challenge path are reworked |
| TLS termination | Caddy on sg01 | Cloudflare edge + origin cert path |
| WebSockets (`wss://`) | Direct to origin via Caddy | Needs CF WebSockets enabled; extra failure mode |
| PWA / service worker | Secure origin already proven path | Usually fine under Full (strict), but harder to debug |
| IP privacy / WAF | Origin IP visible in DNS | Edge absorbs abuse; origin IP can still leak elsewhere |
| Ops complexity | Lower | Higher (SSL mode, always-use-HTTPS, cache rules, WS) |

Evidence that proxy is **off** today: `dig` → origin A record; HTTPS headers
include `via: 1.1 Caddy` and lack `cf-ray`.

### If orange-cloud is needed later (attended recipe only)

Do not flip the proxy switch until all of the following are planned:

1. Cloudflare SSL/TLS mode: **Full (strict)** — never *Flexible* (would
   downgrade origin to HTTP and break Secure-cookie assumptions behind a
   non-loopback edge).
2. Confirm **WebSockets** are enabled for the zone.
3. Prefer **Authenticated Origin Pulls** or an origin cert if locking origin
   to Cloudflare IPs only.
4. ACME strategy: either keep LE on Caddy with DNS-01, or terminate TLS only
   at CF and use an origin certificate — **do not** leave HTTP-01/TLS-ALPN-01
   pointed at CF without verifying challenge reachability.
5. Cache rules: bypass cache for `/mobile/`, `/api/*`, and WebSocket upgrade
   paths (default for many dynamic apps, but verify).
6. Re-run: HTTPS 200, WSS ticket 101, Secure cookie login, SW registration.
7. Tailscale `:14500` path is unchanged (not through Cloudflare).

### Explicit non-goals for D2.4

- No Cloudflare API tokens or zone IDs in git/vault.
- No automatic orange-cloud enablement from agents.
- No change to OCI security lists solely for Cloudflare (still 80/443 only
  from the Internet; 14500 stays closed).

---

## What not to do

- Do not bind Hana to loopback-only while desktop/LAN clients still use Tailscale `:14500`.
- Do not open OCI ingress TCP/14500 to the Internet “for convenience”.
- Do not store Let's Encrypt account keys, CF tokens, or session cookies in git/vault.
- Do not merge permanent draft PR #1 as part of network hardening.
- Do not enable Cloudflare **Flexible** SSL toward this origin.
- Do not orange-cloud `hana.karldigi.dev` without an attended ACME + WSS retest.

---

## Verification commands (copy/paste)

```bash
# Public face
curl -sS -o /dev/null -w "https:%{http_code}\n" --max-time 10 https://hana.karldigi.dev/mobile/
curl -sS -o /dev/null -w "http:%{http_code}\n" --max-time 10 http://hana.karldigi.dev/mobile/
curl -sS -o /dev/null -w "manifest:%{http_code}\n" --max-time 10 https://hana.karldigi.dev/mobile/manifest.webmanifest
curl -sS -o /dev/null -w "sw:%{http_code}\n" --max-time 10 https://hana.karldigi.dev/mobile/sw.js

# Proxy mode check: DNS-only should show origin A + Caddy via, no cf-ray
dig +short hana.karldigi.dev A
curl -sSI --max-time 8 https://hana.karldigi.dev/mobile/ | rg -i '^(via|cf-ray|server):'

# Public 14500 must not answer from the Internet
curl -sS -o /dev/null -w "public14500:%{http_code}\n" --max-time 6 http://161.118.205.111:14500/mobile/ || echo "public14500:timeout-expected"

# Tailscale direct (from a tailnet node)
curl -sS -o /dev/null -w "ts14500:%{http_code}\n" --max-time 6 http://100.125.173.118:14500/mobile/

# On sg01
ss -lntp | grep 14500
systemctl is-active hanaagent caddy
```

---

## Related work items

- Vault: `projects/openhanako/work/2026-07-27-mobile-https-wss-pwa-coverage/`
- Umbrella: `projects/openhanako/work/2026-07-27-post-karlorz7-resume-backlog/`
- Phone UAT (still open): `logs/2026-07-27-handoff-phone-uat-https-pwa.md`
- Installer: `docs/server-install.md`
