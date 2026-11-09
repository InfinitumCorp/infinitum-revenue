import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { bootFromEnv } from "../src/boot.js";
import type { Ctx } from "../src/context.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { FakePayments } from "../src/payments.js";
import { RECAPTCHA_SITEVERIFY_URL, RECAPTCHA_V3_MIN_SCORE, verifyRecaptcha } from "../src/recaptcha.js";

const SECRET = "test-recaptcha-secret";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("verifyRecaptcha", () => {
  it("stays off unless a secret is set, and does not call Google", async () => {
    const fetchImpl = vi.fn();
    for (const secret of [undefined, "", "   "]) {
      const verdict = await verifyRecaptcha({ secret, token: undefined, fetchImpl });
      expect(verdict).toEqual({ ok: true });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a v2 success and a v3 score at the cutoff, via the free siteverify endpoint", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      const score = new URLSearchParams(String(init?.body)).get("response") === "v3" ? RECAPTCHA_V3_MIN_SCORE : undefined;
      return jsonResponse(score === undefined ? { success: true } : { success: true, score });
    });

    expect(await verifyRecaptcha({ secret: SECRET, token: "v2-token", remoteIp: "203.0.113.9", fetchImpl })).toEqual({ ok: true });
    expect(await verifyRecaptcha({ secret: SECRET, token: "v3", fetchImpl })).toEqual({ ok: true });

    expect(seen).toHaveLength(2);
    const hit = seen[0]!;
    expect(hit.url).toBe(RECAPTCHA_SITEVERIFY_URL);
    expect(new URL(hit.url).host).toBe("www.google.com");
    expect(hit.url.toLowerCase()).not.toContain("enterprise");
    expect(hit.url).not.toContain("secret");
    expect(hit.init?.method).toBe("POST");
    expect(hit.init?.redirect).toBe("error");
    const params = new URLSearchParams(String(hit.init?.body));
    expect(params.get("secret")).toBe(SECRET);
    expect(params.get("response")).toBe("v2-token");
    expect(params.get("remoteip")).toBe("203.0.113.9");
  });

  it("rejects a missing token, a failed check, a low v3 score, and an upstream failure", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get("response");
      if (token === "low") return jsonResponse({ success: true, score: RECAPTCHA_V3_MIN_SCORE - 0.1 });
      if (token === "down") return new Response("upstream", { status: 502 });
      if (token === "junk") return new Response("not-json", { status: 200 });
      return jsonResponse({ success: false, "error-codes": ["invalid-input-response"] });
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await verifyRecaptcha({ secret: SECRET, token: undefined, fetchImpl })).toMatchObject({ ok: false, status: 400, code: "recaptcha_required" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "nope", fetchImpl })).toMatchObject({ ok: false, status: 403, code: "recaptcha_failed" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "low", fetchImpl })).toMatchObject({ ok: false, code: "recaptcha_failed" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "x".repeat(4097), fetchImpl })).toMatchObject({ ok: false, code: "recaptcha_failed" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "down", fetchImpl })).toMatchObject({ ok: false, status: 503, code: "recaptcha_unavailable" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "junk", fetchImpl })).toMatchObject({ ok: false, code: "recaptcha_unavailable" });
    expect(await verifyRecaptcha({ secret: SECRET, token: "boom", fetchImpl: async () => { throw new Error("network"); } }))
      .toMatchObject({ ok: false, code: "recaptcha_unavailable" });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET);
    err.mockRestore();
  });
});

describe("POST /v1/signup", () => {
  let db: Db, app: ReturnType<typeof createApp>, open: ReturnType<typeof createApp>, calls: { url: string; init?: RequestInit }[];

  beforeEach(async () => {
    db = await pgliteDb();
    await migrate(db);
    const config: Ctx["config"] = {
      publicUrl: "https://infinitum.test", returnHosts: ["rchtch.app"], adminApiKey: "a".repeat(40),
      tokenPayoutsEnabled: false, recaptchaSecretKey: SECRET,
    };
    app = createApp({ db, pay: new FakePayments(), config });
    open = createApp({ db, pay: new FakePayments(), config: { ...config, recaptchaSecretKey: undefined } });
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const token = new URLSearchParams(String(init?.body)).get("response");
      if (token === "good" || token === "good-body") return jsonResponse({ success: true });
      if (token === "good-v3") return jsonResponse({ success: true, score: 0.9, action: "signup" });
      if (token === "low") return jsonResponse({ success: true, score: 0.1 });
      if (token === "down") return new Response("nope", { status: 500 });
      return jsonResponse({ success: false, "error-codes": ["invalid-input-response"] });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function call(target: ReturnType<typeof createApp>, body?: unknown, headers?: Record<string, string>) {
    const res = await target.request("/v1/signup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? { name: "Ada", email: "ada@x.test" }),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  async function orgCount() {
    const [row] = await db.query<{ n: string }>("select count(*)::text as n from orgs");
    return Number(row?.n ?? 0);
  }

  it("does not challenge signup when the secret is unset", async () => {
    const created = await call(open);
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^ik_/);
    const ignored = await call(open, { name: "Grace", recaptchaToken: "not-checked" });
    expect(ignored.status).toBe(201);
    expect(calls).toHaveLength(0);
    expect(await orgCount()).toBe(2);
  });

  it("accepts a valid header or body token and still lets that key start checkout", async () => {
    const header = await call(app, { name: "Ada", email: "ada@x.test" }, { "x-recaptcha-token": "good", "cf-connecting-ip": "203.0.113.9" });
    expect(header.status).toBe(201);
    expect(header.body.apiKey).toMatch(/^ik_/);
    const body = await call(app, { name: "Grace", recaptchaToken: "good-body" });
    expect(body.status).toBe(201);
    const v3 = await call(app, { name: "Lin", recaptchaToken: "good-v3" });
    expect(v3.status).toBe(201);

    expect(calls.map((c) => c.url)).toEqual([RECAPTCHA_SITEVERIFY_URL, RECAPTCHA_SITEVERIFY_URL, RECAPTCHA_SITEVERIFY_URL]);
    expect(new URLSearchParams(String(calls[0]!.init?.body)).get("remoteip")).toBe("203.0.113.9");

    const checkout = await app.request("/v1/subscriptions/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${header.body.apiKey}` },
      body: JSON.stringify({ planId: "scalvs_pro" }),
    });
    expect(checkout.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("rejects a missing or invalid token and does not create an org", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await call(app);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("recaptcha_required");

    const invalid = await call(app, { name: "Ada", recaptchaToken: "nope" });
    expect(invalid.status).toBe(403);
    expect(invalid.body.error.code).toBe("recaptcha_failed");

    const low = await call(app, { name: "Ada" }, { "x-recaptcha-token": "low" });
    expect(low.body.error.code).toBe("recaptcha_failed");

    const down = await call(app, { name: "Ada", recaptchaToken: "down" });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("recaptcha_unavailable");

    const malformed = await call(app, { email: "not-an-email", recaptchaToken: "good" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_request");

    expect(await orgCount()).toBe(0);
    expect(calls.map((c) => new URLSearchParams(String(c.init?.body)).get("response"))).toEqual(["nope", "low", "down"]);
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET);
    err.mockRestore();
  });

  it("does not consult reCAPTCHA for Stripe webhooks", async () => {
    const bad = await app.request("/v1/webhooks/payments", { method: "POST", headers: { "stripe-signature": "nope" }, body: "{}" });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error.code).toBe("bad_signature");

    const ok = await app.request("/v1/webhooks/payments", {
      method: "POST",
      headers: { "stripe-signature": "test", "content-type": "application/json" },
      body: JSON.stringify({ kind: "ignored", eventId: "evt_rc", type: "ping" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).received).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("allows the token header on product-origin CORS preflight", async () => {
    const pre = await app.request("/v1/signup", { method: "OPTIONS", headers: {
      origin: "https://rchtch.app", "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-recaptcha-token",
    } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://rchtch.app");
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-recaptcha-token");
  });
});

describe("bootFromEnv", () => {
  const previous = {
    recaptcha: process.env.RECAPTCHA_SECRET_KEY,
    stripe: process.env.STRIPE_SECRET_KEY,
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    dir: process.env.PGLITE_DIR,
  };

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : (process.env[key] = value);
    restore("RECAPTCHA_SECRET_KEY", previous.recaptcha);
    restore("STRIPE_SECRET_KEY", previous.stripe);
    restore("STRIPE_WEBHOOK_SECRET", previous.webhook);
    restore("PGLITE_DIR", previous.dir);
  });

  it("reads RECAPTCHA_SECRET_KEY and leaves Stripe on the fake provider when Stripe is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinitum-recaptcha-"));
    process.env.PGLITE_DIR = dir;
    process.env.RECAPTCHA_SECRET_KEY = "  from-env  ";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const { ctx } = await bootFromEnv();
      expect(ctx.config.recaptchaSecretKey).toBe("from-env");
      expect(ctx.pay).toBeInstanceOf(FakePayments);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
