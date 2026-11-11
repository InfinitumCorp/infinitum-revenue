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

- Each has a dynamic public IPv4 (NAT) on the zone's `default-ru-central1-*` subnet and the network's default security group.
- Label: `product=infinitum`.
- Zone ru-central1-b is skipped on purpose (Yandex status warnings at creation time).
- Public IPs are not listed here because this repo is public. Get them with:
  `yc compute instance list --folder-id b1g3bonfmtl53fs762er`

## Access

- SSH key only, user `yc-user`. The key is `yandex_infinitum` (ed25519) on William's PC. The private key is never committed.
- Host shortcuts are in `~/.ssh/config` on that PC: `ssh infinitum-product-1` (and -2, -3).

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

## Follow-ups

- Lock down the default security group (allow 22 from known IPs, 80/443 public) before anything is exposed.
- Reserve static IPs if DNS will point at these servers (dynamic IPs change on stop/start).
- Set up disk snapshot schedules for backups (Cloud Backup is off).
