# Yandex Cloud: Infinitum product servers (Russia)

Created 2026-11-11 for the Infinitum product's Russia footprint.

## Where

- Cloud: `cloud-squall-481` (`b1ge7a8mfl3d020u4gho`)
- Folder: `default` (`b1g3bonfmtl53fs762er`)
- Billing: individual account, RUB, linked 2026-11-11 (4,000 ₽ starter grant)

## Servers

| Name | Zone | Platform | vCPU | RAM | Boot disk | OS |
|---|---|---|---|---|---|---|
| infinitum-product-1 | ru-central1-a | standard-v3 (Ice Lake), 100% | 2 | 4 GB | 10 GB network-ssd | Ubuntu 24.04 LTS |
| infinitum-product-2 | ru-central1-d | standard-v3 (Ice Lake), 100% | 2 | 4 GB | 10 GB network-ssd | Ubuntu 24.04 LTS |
| infinitum-product-3 | ru-central1-e | standard-v3 (Ice Lake), 100% | 2 | 4 GB | 10 GB network-ssd | Ubuntu 24.04 LTS |

- Each has a dynamic public IPv4 (NAT) on the zone's `default-ru-central1-*` subnet.
- Label: `product=infinitum`.
- Zone ru-central1-b is skipped on purpose (Yandex status warnings at creation time).
- Public IPs are not listed here because this repo is public. Get them with:
  `yc compute instance list --folder-id b1g3bonfmtl53fs762er`

## Access

- SSH key only, user `yc-user`. The key is `yandex_infinitum` (ed25519) on William's PC. The private key is never committed.
- Host shortcuts are in `~/.ssh/config` on that PC: `ssh infinitum-product-1` (and -2, -3).

## Firewall

All three servers use security group `infinitum-product-sg` (`enpcv3ntnffkgvkgv0a5`), attached 2026-11-11:

| Direction | Port | From / to | Why |
|---|---|---|---|
| in | 22/tcp | William's admin IP only (/32) | SSH |
| in | 80, 443/tcp | anywhere | web |
| in | ICMP | anywhere | ping |
| in | any | the same group | server-to-server |
| out | any | anywhere | updates, GitHub, registries |

Everything else inbound is dropped (verified from Cloud Shell). If the admin IP changes, SSH stops working: update the port-22 rule from the console or Cloud Shell, which do not need SSH.

## Cost (console calculator, VAT incl., per server per month)

| Item | ₽ |
|---|---|
| 2 vCPU | 1,785.60 |
| 4 GB RAM | 950.40 |
| 10 GB SSD | ~143 |
| Public IP | 189.73 |
| **Per server** | **~3,069** |
| **3 servers** | **~9,207** |

## Quotas hit at creation (new-account defaults, per zone)

- network-ssd: 10 GB, network-hdd: 20 GB, vCPU: 2, RAM: 16 GB, instances: 12 per cloud.
- That is why the boot disks are 10 GB and there is one server per zone.
- To grow disks or add a second server in a zone, request an increase on the console's Quotas page first.

## scalvs-ru (live on all three servers since 2026-11-11)

- nginx on each server serves `/var/www/scalvs-ru` as the default site and for `Host: ru.scalvs.app` (HTTP only until DNS and TLS move).
- GitHub runners `yandex-ru-1/2/3` (labels `yandex-ru`, `yandex-ru-N`) are registered to InfinitumCorp/scalvs-ru and run as the non-root `runner` user under systemd.
- Workflow `deploy-yandex.yml` (scalvs-ru PR #4) rsyncs `main` to all three on every push to main; never on pull requests.
- DNS for ru.scalvs.app still points at GitHub Pages. Moving it here needs static IPs, a DNS change and certbot.

## Fabric homeserver (temporary home: infinitum-product-1, since 2026-11-11)

A dedicated Fabric server could not be created: Yandex has closed ru-central1-b to new VMs and zones a/d/e are at the 2-vCPU quota. Until the quota is raised, Fabric's Russia homeserver runs on infinitum-product-1.

- `/opt/fabric`: Docker Compose with `matrixdotorg/synapse:v1.164.2` and `postgres:16`, matching InfinitumCorp/fabric `server/docker-compose.yml`.
- `server_name: ru.infinitumfabric.app` (permanent: it becomes part of every user ID).
- Closed registration (no token → 403), federation listener removed (→ 404), empty `federation_domain_whitelist` and `trusted_key_servers`.
- Synapse listens on `127.0.0.1:8008` only. It is not reachable from the internet until nginx + TLS on a real hostname are added.
- DB password lives only in `/opt/fabric/.env` on the server (mode 600). An unused `homeserver.db` from the first boot is still in `/opt/fabric/data` and can be deleted.

To move it to its own server later: stop the stack, copy `/opt/fabric`, start it on the new VM.

## Using the servers for builds

Today every InfinitumCorp repo is public, so GitHub-hosted runners are free, and the Grok Bot box already has an `infinitum-ci` runner registered per repo as the fallback. Using these paid servers for general CI would cost money for work GitHub does for free. Their value is what only a machine inside Russia can do:

1. **Deploy the Russia mirrors from inside Russia.** Build on GitHub-hosted runners as now, then a deploy job on a Yandex runner (label `yandex-ru`) pulls the artifact and serves it from these servers with nginx on 80/443. Candidates: `scalvs-ru` (today on GitHub Pages, which is unreliable in Russia) and the Cumulus ID mirror needed for "works in Russia without a VPN".
2. **Smoke-test from Russia.** A scheduled-on-deploy (not cron) job on a `yandex-ru` runner checks that id.cumuluscloud.app's mirror, scalvs-ru and other Russia-facing apps load and sign in from a Russian IP.
3. **Overflow builds.** Register them as extra `infinitum-ci` runners, used only if `CI_RUNNER=infinitum-ci` is ever set.

Rules for the runners:
- Trigger only on `push` to the default branch and `workflow_dispatch`, never `pull_request` from forks: the repos are public, so a fork PR could otherwise run code on these servers. Keep "Require approval for all outside collaborators" on in each repo's Actions settings.
- One runner per repo per server (personal account, so no org-level runners), run as a non-root `runner` user, ephemeral where possible.
- Raise the SSD quota to 30–50 GB per zone first; 7 GB free is too little for node_modules/Docker builds.
- Excluded from these runners: defense products (AETHER, infinitumdefense.com, E(O)N).

## Follow-ups

- Reserve static IPs if DNS will point at these servers (dynamic IPs change on stop/start).
- Set up disk snapshot schedules for backups (Cloud Backup is off).
