import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Checkout may only return to Infinitum product sites, and never to a military/defense site.
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const hosts = (/"RETURN_HOSTS":\s*"([^"]+)"/.exec(wrangler)?.[1] ?? "").split(",");
const boot = readFileSync(new URL("../src/boot.ts", import.meta.url), "utf8");

describe("RETURN_HOSTS", () => {
  it("lists every product that sells plans through checkout", () => {
    for (const h of ["scalvs.app", "cndctr.app", "rchtch.app", "mttrn.app", "cumuluscloud.app", "infinitumfabric.app", "infinitumveilvpn.app", "infinitumcorporation.ai"])
      expect(hosts).toContain(h);
  });
  it("never lists a military or defense site", () => {
    expect(hosts.some((h) => /defense|aether|eon/i.test(h))).toBe(false);
  });
  it("the code default matches wrangler.jsonc", () => {
    expect(boot).toContain(hosts.join(","));
  });
});
