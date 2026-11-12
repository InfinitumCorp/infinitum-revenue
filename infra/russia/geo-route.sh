#!/bin/bash
# Send visitors in Russia to each product's own Russia server.
# Adds (or updates) one Cloudflare Single Redirect rule per product zone:
#   ip.src.country eq "RU" and host is the product's main name  ->  302 to https://ru.<name><same path>?<same query>
# The ru.* names are DNS-only A records to the product's Yandex server, so after the first
# request the visitor's whole session (pages, sign-in return, assets) is served from Russia.
# Existing redirect rules in each zone are kept; only the rule with our ref is replaced.
#   bash geo-route.sh            # dry run: prints what would change
#   APPLY=1 bash geo-route.sh    # writes the rules (asks for a Cloudflare token: Zone > Dynamic Redirect > Edit)
set -euo pipefail
API=https://api.cloudflare.com/client/v4

# zone | main hosts (space-separated) | Russia host | paths that must not redirect (POST/API/webhooks)
ROUTES=(
  "scalvs.app|scalvs.app www.scalvs.app|ru.scalvs.app|/api/"
  "infinitumcorporation.ai|infinitumcorporation.ai www.infinitumcorporation.ai|ru.infinitumcorporation.ai|/api/"
  "infinitumveilvpn.app|infinitumveilvpn.app www.infinitumveilvpn.app|ru.infinitumveilvpn.app|/api/"
)
# Not here on purpose: conjure.infinitumcorporation.ai already forwards everything to Russia;
# lbrnth.cumuluscloud.app is Russia-only; infinitumfabric.app's Russia homeserver is a separate
# closed server with its own accounts, so redirecting would strand existing users.

if [ "${APPLY:-0}" = 1 ]; then
  read -rsp "Cloudflare API token: " CF_API_TOKEN; echo
fi
cf() { curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' "$@"; }

for route in "${ROUTES[@]}"; do
  IFS='|' read -r ZONE HOSTS RU SKIP <<<"$route"
  hosts=$(printf '"%s" ' $HOSTS)
  expr="(ip.src.country eq \"RU\" and http.host in {${hosts% }} and not starts_with(http.request.uri.path, \"$SKIP\") and not starts_with(http.request.uri.path, \"/.well-known/\"))"
  rule=$(jq -n --arg ref "geo-ru-${ZONE//./-}" --arg expr "$expr" --arg ru "$RU" '{
    ref: $ref, description: "Visitors in Russia -> \($ru) (Yandex)", expression: $expr, action: "redirect",
    action_parameters: { from_value: { status_code: 302, preserve_query_string: true,
      target_url: { expression: "concat(\"https://\($ru)\", http.request.uri.path)" } } } }')
  echo "== $ZONE"; echo "$rule" | jq -c .
  [ "${APPLY:-0}" = 1 ] || continue

  zid=$(cf "$API/zones?name=$ZONE" | jq -r '.result[0].id')
  cur=$(cf "$API/zones/$zid/rulesets/phases/http_request_dynamic_redirect/entrypoint" 2>/dev/null | jq '.result.rules // []' || echo '[]')
  body=$(jq -n --argjson cur "$cur" --argjson rule "$rule" '{rules: ([$cur[] | select(.ref != $rule.ref) | del(.id, .version, .last_updated)] + [$rule])}')
  cf -X PUT "$API/zones/$zid/rulesets/phases/http_request_dynamic_redirect/entrypoint" -d "$body" | jq -r '"ok: \(.result.rules | length) redirect rule(s) in zone"'
done
[ "${APPLY:-0}" = 1 ] || echo "(dry run; APPLY=1 to write)"
