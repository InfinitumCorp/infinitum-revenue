import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { FakePayments } from "../src/payments.js";
import type { Ctx } from "../src/context.js";
import { createCidVerifier } from "../src/cid.js";

const ISSUER = "https://id.cumuluscloud.test/realms/cumulus";
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function keyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const head = enc({ alg: "RS256", typ: "JWT", kid }), body = enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwk, sign };
}

const now = () => Math.floor(Date.now() / 1000);

describe("Cumulus ID token verification", () => {
  it("accepts a valid token and rejects wrong issuer, expiry, unknown key and audience", async () => {
    const { jwk, sign } = await keyPair();
    let fetches = 0;
    const fakeFetch = (async () => { fetches++; return new Response(JSON.stringify({ keys: [jwk] })); }) as typeof fetch;
    const verify = createCidVerifier({ issuer: ISSUER, fetch: fakeFetch, audiences: ["eidetic"] });
    const good = { iss: ISSUER, sub: "user-1", exp: now() + 300, azp: "eidetic", email: "a@cumuluscloud.app", name: "Ada" };

    expect(await verify(await sign(good))).toEqual({ sub: "user-1", email: "a@cumuluscloud.app", name: "Ada" });
    expect(await verify(await sign({ ...good, iss: "https://evil.test" }))).toBeNull();
    expect(await verify(await sign({ ...good, exp: now() - 3600 }))).toBeNull();
    expect(await verify(await sign({ ...good, azp: "other-app" }))).toBeNull();
    expect(await verify(await sign(good, "unknown-kid"))).toBeNull();
    const t = await sign(good);
    expect(await verify(t.slice(0, -4) + "AAAA")).toBeNull(); // tampered signature
    expect(await verify("ik_not_a_jwt")).toBeNull();
    expect(fetches).toBeGreaterThan(0);
  });
});

describe("customer API with a Cumulus ID token", () => {
  let db: Db, app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    db = await pgliteDb();
    await migrate(db);
    const ctx: Ctx = {
      db, pay: new FakePayments(),
      config: { publicUrl: "https://infinitum.test", returnHosts: ["eidetic.app"], adminApiKey: "a".repeat(40), tokenPayoutsEnabled: false },
      cid: async (token) => (token === "h.cidtoken.s" ? { sub: "cid-42", email: "w@cumuluscloud.app", name: "W" } : null),
    };
    app = createApp(ctx);
  });
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("creates one org per Cumulus ID and lets the user check out a plan", async () => {
    const a = await call("GET", "/v1/me/entitlements", "h.cidtoken.s");
    expect(a.status).toBe(200);
    const b = await call("GET", "/v1/me/entitlements", "h.cidtoken.s");
    expect(b.status).toBe(200);
    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from cid_links");
    expect(n).toBe(1);

    const co = await call("POST", "/v1/subscriptions/checkout", "h.cidtoken.s", { planId: "scalvs_pro", returnUrl: "https://eidetic.app/billing" });
    expect(co.status).toBe(200);
    expect(co.body.url).toBeTruthy();
  });

  it("lets the user switch to a business org but never to military", async () => {
    const ok = await call("POST", "/v1/me/org", "h.cidtoken.s", { name: "Acme", kind: "business" });
    expect(ok.body).toMatchObject({ name: "Acme", kind: "business" });
    const bad = await call("POST", "/v1/me/org", "h.cidtoken.s", { kind: "military" });
    expect(bad.status).toBe(400);
  });

  it("rejects a bad token", async () => {
    expect((await call("GET", "/v1/me/entitlements", "h.bad.s")).status).toBe(401);
  });
});
