import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { FakePayments } from "../src/payments.js";
import type { Ctx } from "../src/context.js";

const PARTNER = "p".repeat(40);

describe("billing hub acting for a Cumulus ID (partner key)", () => {
  let db: Db, app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    db = await pgliteDb();
    await migrate(db);
    const ctx: Ctx = {
      db, pay: new FakePayments(),
      config: { publicUrl: "https://infinitum.test", returnHosts: ["scalvs.app"], adminApiKey: "a".repeat(40), tokenPayoutsEnabled: false, cidPartnerKey: PARTNER },
      cid: async (token) => (token === "h.cidtoken.s" ? { sub: "cid-42", email: "w@cumuluscloud.app" } : null),
    };
    app = createApp(ctx);
  });
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const asHub = (cid: string) => ({ authorization: `Bearer ${PARTNER}`, "x-cumulus-id": cid });

  it("the hub and a product app share one billing org per Cumulus ID", async () => {
    const hub = await call("POST", "/v1/subscriptions/checkout", asHub("cid-42"), { planId: "scalvs_pro", returnUrl: "https://scalvs.app/" });
    expect(hub.status).toBe(200);
    const app1 = await call("GET", "/v1/me/entitlements", { authorization: "Bearer h.cidtoken.s" });
    const hub1 = await call("GET", "/v1/me/entitlements", asHub("cid-42"));
    expect(app1.body.orgId).toBe(hub1.body.orgId);
    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from cid_links");
    expect(n).toBe(1);
  });

  it("refuses a wrong partner key and a missing Cumulus ID", async () => {
    expect((await call("GET", "/v1/me/entitlements", { authorization: `Bearer ${"q".repeat(40)}`, "x-cumulus-id": "cid-42" })).status).toBe(401);
    expect((await call("GET", "/v1/me/entitlements", { authorization: `Bearer ${PARTNER}` })).status).toBe(400);
  });

  it("adopts an org the hub made before, once, and never someone else's", async () => {
    const su = await call("POST", "/v1/signup", {}, { name: "Old hub org", kind: "individual" });
    expect(su.status).toBe(201);
    const key = su.body.apiKey as string;
    // Without the partner key, an org API key alone cannot claim a Cumulus ID.
    expect((await call("POST", "/v1/me/cid-link", { authorization: `Bearer ${key}`, "x-cumulus-id": "cid-7" })).status).toBe(403);
    const link = { authorization: `Bearer ${key}`, "x-cid-partner-key": PARTNER, "x-cumulus-id": "cid-7" };
    expect((await call("POST", "/v1/me/cid-link", link)).body).toEqual({ linked: true, orgId: su.body.orgId });
    expect((await call("POST", "/v1/me/cid-link", link)).status).toBe(200); // idempotent
    expect((await call("GET", "/v1/me/entitlements", asHub("cid-7"))).body.orgId).toBe(su.body.orgId);
    // The same org cannot be linked to a second Cumulus ID, and cid-7 cannot take another org.
    expect((await call("POST", "/v1/me/cid-link", { ...link, "x-cumulus-id": "cid-8" })).status).toBe(409);
    const other = await call("POST", "/v1/signup", {}, { name: "Other", kind: "individual" });
    expect((await call("POST", "/v1/me/cid-link", { ...link, authorization: `Bearer ${other.body.apiKey}` })).status).toBe(409);
  });

  it("is off when no partner key is configured", async () => {
    const off = createApp({ db, pay: new FakePayments(), config: { publicUrl: "https://infinitum.test", adminApiKey: "a".repeat(40), tokenPayoutsEnabled: false } });
    const res = await off.request("/v1/me/entitlements", { headers: { authorization: `Bearer ${PARTNER}`, "x-cumulus-id": "cid-42" } });
    expect(res.status).toBe(401);
  });
});
