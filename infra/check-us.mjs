#!/usr/bin/env node
// Read-only check of the US setup (infra/us-cloudflare.md): which Workers run on US servers
// (placement gcp:us-east4) and whether the Russia redirect rules are in place. Changes nothing.
//
//   CLOUDFLARE_API_TOKEN=... node infra/check-us.mjs
//
// Needs Workers Scripts: Read and Zone Rulesets (Single Redirect): Read. Exit code 1 if anything
// that should be on US servers is not, or a Russia rule is missing.

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "1a9f2df27b4a1f9e3de82eab367434e4";
const REGION = "gcp:us-east4";
const API = "https://api.cloudflare.com/client/v4";

// Not Infinitum products, or no fetch handler (placement does not apply): not expected on US placement.
export const EXEMPT = new Set([
  "capital-chronicles", "prpgnd", "vyral-london", "william-aaron-turner", "williamaaronturner-redesign",
  "veil-crawler", "cumulus-mail-inbound", "conjure-front",
  "app-hub-redirect", "cndctr-redirect", "infinitum-www-redirect",
]);
export const RU_ZONES = ["scalvs.app", "infinitumcorporation.ai", "infinitumveilvpn.app"];

/** The region a Worker is pinned to, from either shape the API returns. */
export function placementRegion(p) {
  if (!p) return undefined;
  if (typeof p.region === "string") return p.region;
  const t = Array.isArray(p.target) ? p.target.find(x => x && x.region) : undefined;
  return t?.region;
}

async function cf(path) {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors ?? res.status)}`);
  return body.result;
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("Set CLOUDFLARE_API_TOKEN");
  let bad = 0;
  const scripts = await cf(`/accounts/${ACCOUNT}/workers/scripts`);
  for (const s of scripts.sort((a, b) => a.id.localeCompare(b.id))) {
    const region = placementRegion(s.placement);
    const ok = region === REGION;
    const exempt = EXEMPT.has(s.id);
    if (!ok && !exempt) bad++;
    console.log(`${ok ? "US  " : exempt ? "--  " : "MISS"} ${s.id}${region && !ok ? ` (${region})` : ""}`);
  }
  for (const zone of RU_ZONES) {
    const [z] = await cf(`/zones?name=${encodeURIComponent(zone)}`);
    let rules = [];
    try { rules = (await cf(`/zones/${z.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`)).rules ?? []; } catch { /* no entrypoint yet */ }
    const ok = rules.some(r => r.ref === "infinitum-ru-geo" && r.enabled !== false);
    if (!ok) bad++;
    console.log(`${ok ? "RU  " : "MISS"} ${zone} Russia redirect`);
  }
  console.log(bad ? `${bad} problem(s)` : "All good");
  process.exitCode = bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1); });
