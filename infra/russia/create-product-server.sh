#!/bin/bash
# Create one product's own Yandex Cloud server, the same shape as the other Russia servers.
# Run from a machine with `yc` signed in to cloud-squall-481. Needs William's OK first (it costs money).
#   bash create-product-server.sh <vm-name> <zone> <product-label>
#   e.g. bash create-product-server.sh scalvs-russia ru-central1-a scalvs
set -euo pipefail
NAME=${1:?vm name, e.g. scalvs-russia}
ZONE=${2:?zone: ru-central1-a, -d or -e (b is closed, f has no disk quota)}
PRODUCT=${3:?product label, e.g. scalvs}
FOLDER=b1g3bonfmtl53fs762er
SG=enpcv3ntnffkgvkgv0a5            # infinitum-product-sg: 22 from the admin IP, 80/443, ICMP
SNAPSHOTS=fd8l3q6kcg93enulpjuj     # daily-data-servers: 00:00 UTC, keeps 7
PUBKEY=${PUBKEY:-$HOME/.ssh/yandex_infinitum.pub}

yc compute instance create \
  --folder-id "$FOLDER" --name "$NAME" --zone "$ZONE" \
  --platform standard-v3 --cores 2 --core-fraction 100 --memory 4GB \
  --create-boot-disk image-folder-id=standard-images,image-family=ubuntu-2404-lts,type=network-ssd,size=20GB \
  --network-interface subnet-name="default-$ZONE",nat-ip-version=ipv4,security-group-ids="$SG" \
  --ssh-key "$PUBKEY" \
  --labels "product=$PRODUCT,region=russia"

DISK=$(yc compute instance get "$NAME" --folder-id "$FOLDER" --format json | jq -r '.boot_disk.disk_id')
yc compute snapshot-schedule add-disks "$SNAPSHOTS" --disk-id "$DISK"
IP=$(yc compute instance get "$NAME" --folder-id "$FOLDER" --format json | jq -r '.network_interfaces[0].primary_v4_address.one_to_one_nat.address')
echo "$NAME: $IP (dynamic), boot disk $DISK added to daily snapshots"
echo "Next: add Host $NAME to ~/.ssh/config, then reserve the IP as static once the quota allows:"
echo "  yc vpc address update --folder-id $FOLDER --reserved=true \$(yc vpc address list --folder-id $FOLDER --format json | jq -r '.[] | select(.external_ipv4_address.address==\"$IP\") | .id')"
