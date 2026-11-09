import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachAws, CLOUDWATCH_METRICS, drainAws, paymentNotice, readAwsConfig } from "../src/aws.js";
import { createApp } from "../src/app.js";
import { bootFromEnv } from "../src/boot.js";
import type { Ctx } from "../src/context.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { FakePayments, type PaymentEvent } from "../src/payments.js";

const REGION = "us-east-1";
const ACCESS_KEY = "test-access-key";
const SECRET = "test-secret-key";
const TOKEN = "test-session-token";
const TOPIC = `arn:aws:sns:${REGION}:123456789012:infinitum-revenue`;
const NAMESPACE = "Infinitum/Revenue";

const enabledEnv: NodeJS.ProcessEnv = {
  AWS_REGION: REGION,
  AWS_ACCESS_KEY_ID: ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_SESSION_TOKEN: TOKEN,
  SNS_TOPIC_ARN: TOPIC,
  CLOUDWATCH_NAMESPACE: NAMESPACE,
};

function form(body: string) {
  return new URLSearchParams(body);
}

describe("readAwsConfig", () => {
  it("stays off unless region, credentials, and a specific adapter setting are all set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readAwsConfig({})).toBeUndefined();
    expect(readAwsConfig({ AWS_REGION: REGION, AWS_ACCESS_KEY_ID: ACCESS_KEY, AWS_SECRET_ACCESS_KEY: SECRET })).toBeUndefined();
    expect(readAwsConfig({ SNS_TOPIC_ARN: TOPIC, CLOUDWATCH_NAMESPACE: NAMESPACE })).toBeUndefined();
    expect(readAwsConfig({ ...enabledEnv, AWS_REGION: "us-east-1.evil.example" })).toBeUndefined();
    expect(readAwsConfig({ ...enabledEnv, SNS_TOPIC_ARN: "arn:aws:sns:eu-west-1:123456789012:other", CLOUDWATCH_NAMESPACE: "" })).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    warn.mockRestore();

    expect(readAwsConfig(enabledEnv)).toMatchObject({ region: REGION, snsTopicArn: TOPIC, cloudWatchNamespace: NAMESPACE, sessionToken: TOKEN });
    expect(readAwsConfig({ ...enabledEnv, SNS_TOPIC_ARN: "", CLOUDWATCH_NAMESPACE: NAMESPACE })?.snsTopicArn).toBeUndefined();
  });
});

describe("paymentNotice", () => {
  it("keeps ids and drops amounts, metadata, emails, and card-like numbers", () => {
    const notice = paymentNotice({
      kind: "invoice.paid", eventId: "evt_1", invoiceId: "in_1", customerId: "ada@x.test",
      amountCents: 9900, metadata: { email: "ada@x.test", note: "secret" },
    } as PaymentEvent, { duplicate: false });
    expect(notice).toEqual({ kind: "invoice.paid", eventId: "evt_1", duplicate: false, ids: { invoiceId: "in_1" } });

    const card = paymentNotice({ kind: "checkout.completed", eventId: "evt_2", sessionId: "cs_1", orgId: "4242424242424242", purpose: "order", ref: "ord_1", amountCents: 100 } as PaymentEvent);
    expect(card.ids).toEqual({ sessionId: "cs_1", purpose: "order", ref: "ord_1" });
    expect(JSON.stringify(card)).not.toContain("4242");
    expect(JSON.stringify(card)).not.toContain("amountCents");
  });
});

describe("AWS adapters", () => {
  let db: Db, ctx: Ctx, app: ReturnType<typeof createApp>, calls: { url: string; body: string; headers: Headers; redirect: RequestRedirect }[];

  const fetchImpl = async (input: RequestInfo | URL) => {
    const request = input as Request;
    calls.push({ url: request.url, body: await request.clone().text(), headers: request.headers, redirect: request.redirect });
    return new Response("<Ok/>", { status: 200 });
  };

  beforeEach(async () => {
    db = await pgliteDb();
    await migrate(db);
    calls = [];
    ctx = {
      db, pay: new FakePayments(),
      config: { publicUrl: "https://infinitum.test", returnHosts: ["scalvs.app"], adminApiKey: "a".repeat(40), tokenPayoutsEnabled: false },
    };
    attachAws(ctx, enabledEnv, fetchImpl as typeof fetch);
    app = createApp(ctx);
  });

  afterEach(() => drainAws(ctx));

  function posted(action: string) {
    return calls.filter((c) => form(c.body).get("Action") === action);
  }

  async function webhook(event: Record<string, unknown>, signature = "test") {
    const res = await app.request("/v1/webhooks/payments", {
      method: "POST",
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const body = await res.json() as any;
    await drainAws(ctx);
    return { status: res.status, body };
  }

  it("does nothing when the adapters are not attached", async () => {
    const bare = createApp({ ...ctx, aws: undefined, pending: undefined, pay: new FakePayments() });
    const boom = vi.fn(async () => { throw new Error("aws should not be called"); });
    vi.stubGlobal("fetch", boom);
    try {
      const res = await bare.request("/v1/webhooks/payments", {
        method: "POST", headers: { "stripe-signature": "test" },
        body: JSON.stringify({ kind: "ignored", eventId: "evt_off", type: "ping" }),
      });
      expect(res.status).toBe(200);
      expect(boom).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes an id-only SNS notice and a batched metric after a verified event", async () => {
    const first = await webhook({ kind: "ignored", eventId: "evt_aws", type: "customer.updated" });
    expect(first.status).toBe(200);
    expect(first.body.received).toBe(true);

    const sns = posted("Publish");
    const metrics = posted("PutMetricData");
    expect(sns).toHaveLength(1);
    expect(metrics).toHaveLength(1);
    expect(new URL(sns[0]!.url).host).toBe(`sns.${REGION}.amazonaws.com`);
    expect(new URL(metrics[0]!.url).host).toBe(`monitoring.${REGION}.amazonaws.com`);
    expect(sns[0]!.redirect).toBe("error");

    const snsForm = form(sns[0]!.body);
    expect(snsForm.get("TopicArn")).toBe(TOPIC);
    expect(snsForm.get("Version")).toBe("2010-03-31");
    expect(snsForm.get("PhoneNumber")).toBeNull();
    expect(snsForm.get("MessageStructure")).toBeNull();
    expect(snsForm.get("Protocol")).toBeNull();
    expect(JSON.parse(snsForm.get("Message")!)).toEqual({ kind: "ignored", eventId: "evt_aws", type: "customer.updated" });

    const metricForm = form(metrics[0]!.body);
    expect(metricForm.get("Namespace")).toBe(NAMESPACE);
    expect(metricForm.get("MetricData.member.1.MetricName")).toBe("WebhookProcessed");
    expect(metricForm.get("MetricData.member.1.Value")).toBe("1");
    expect(metricForm.get("MetricData.member.1.Unit")).toBe("Count");
    expect(metricForm.get("MetricData.member.1.StorageResolution")).toBe("60");
    expect(metrics[0]!.body).not.toContain("Dimensions");
    expect([...metricForm.values()].filter((v) => CLOUDWATCH_METRICS.includes(v as typeof CLOUDWATCH_METRICS[number]))).toEqual(["WebhookProcessed"]);

    const authorization = sns[0]!.headers.get("authorization") ?? "";
    expect(authorization).toMatch(new RegExp(`AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/${REGION}/sns/aws4_request`));
    expect(authorization).not.toContain(SECRET);
    expect(sns[0]!.url).not.toContain(SECRET);
    expect(sns[0]!.body).not.toContain(SECRET);
    expect(sns[0]!.headers.get("x-amz-security-token")).toBe(TOKEN);

    const again = await webhook({ kind: "ignored", eventId: "evt_aws", type: "customer.updated" });
    expect(again.body.duplicate).toBe(true);
    expect(posted("Publish")).toHaveLength(1);
    expect(posted("PutMetricData")).toHaveLength(2);
  });

  it("keeps the webhook response when AWS returns an error, and counts processing failures", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    calls.length = 0;
    const failing = async (input: RequestInfo | URL) => {
      const request = input as Request;
      calls.push({ url: request.url, body: await request.clone().text(), headers: request.headers, redirect: request.redirect });
      return new Response("no", { status: 503 });
    };
    const failingCtx: Ctx = {
      db, pay: new FakePayments(),
      config: ctx.config,
    };
    attachAws(failingCtx, enabledEnv, failing as typeof fetch);
    const failingApp = createApp(failingCtx);
    const res = await failingApp.request("/v1/webhooks/payments", {
      method: "POST", headers: { "stripe-signature": "test" },
      body: JSON.stringify({ kind: "ignored", eventId: "evt_down", type: "ping" }),
    });
    expect(res.status).toBe(200);
    await drainAws(failingCtx);
    expect(posted("Publish")).toHaveLength(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET);
    err.mockRestore();

    ctx.db.tx = async () => { throw new Error("db down"); };
    calls.length = 0;
    const broken = await webhook({ kind: "ignored", eventId: "evt_fail", type: "ping" });
    expect(broken.status).toBe(500);
    expect(posted("Publish")).toHaveLength(0);
    expect(form(posted("PutMetricData")[0]!.body).get("MetricData.member.1.MetricName")).toBe("WebhookFailed");
  });

  it("does not call AWS when the Stripe signature is rejected", async () => {
    const res = await webhook({ kind: "ignored", eventId: "evt_bad", type: "ping" }, "nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_signature");
    expect(calls).toHaveLength(0);
  });

  it("counts a checkout session without publishing to SNS", async () => {
    const signup = await app.request("/v1/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@x.test" }),
    });
    const { apiKey } = await signup.json() as { apiKey: string };
    const checkout = await app.request("/v1/subscriptions/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ planId: "scalvs_pro" }),
    });
    expect(checkout.status).toBe(200);
    await drainAws(ctx);
    expect(posted("Publish")).toHaveLength(0);
    expect(form(posted("PutMetricData")[0]!.body).get("MetricData.member.1.MetricName")).toBe("CheckoutCreated");
  });

  it("batches webhook and checkout metrics into one PutMetricData call", async () => {
    ctx.aws?.paymentProcessed(paymentNotice({ kind: "ignored", eventId: "evt_batch", type: "ping" } as PaymentEvent));
    ctx.aws?.checkoutCreated();
    await drainAws(ctx);
    expect(posted("Publish")).toHaveLength(1);
    const metrics = posted("PutMetricData");
    expect(metrics).toHaveLength(1);
    const body = form(metrics[0]!.body);
    const names = [...body.values()].filter((v) => (CLOUDWATCH_METRICS as readonly string[]).includes(v));
    expect(names).toEqual(["WebhookProcessed", "CheckoutCreated"]);
    expect(body.get("MetricData.member.3.MetricName")).toBeNull();
  });
});

describe("bootFromEnv AWS gate", () => {
  const previous = {
    region: process.env.AWS_REGION,
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    token: process.env.AWS_SESSION_TOKEN,
    topic: process.env.SNS_TOPIC_ARN,
    namespace: process.env.CLOUDWATCH_NAMESPACE,
    dir: process.env.PGLITE_DIR,
    stripe: process.env.STRIPE_SECRET_KEY,
  };

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => value === undefined ? delete process.env[name] : (process.env[name] = value);
    restore("AWS_REGION", previous.region);
    restore("AWS_ACCESS_KEY_ID", previous.key);
    restore("AWS_SECRET_ACCESS_KEY", previous.secret);
    restore("AWS_SESSION_TOKEN", previous.token);
    restore("SNS_TOPIC_ARN", previous.topic);
    restore("CLOUDWATCH_NAMESPACE", previous.namespace);
    restore("PGLITE_DIR", previous.dir);
    restore("STRIPE_SECRET_KEY", previous.stripe);
  });

  it("wires the adapters from the environment and leaves them off when it is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinitum-aws-"));
    process.env.PGLITE_DIR = dir;
    delete process.env.STRIPE_SECRET_KEY;
    Object.assign(process.env, enabledEnv);
    try {
      const on = await bootFromEnv();
      expect(on.ctx.aws).toBeDefined();
      expect(on.ctx.pay).toBeInstanceOf(FakePayments);
      for (const name of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "SNS_TOPIC_ARN", "CLOUDWATCH_NAMESPACE"]) delete process.env[name];
      const off = await bootFromEnv();
      expect(off.ctx.aws).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
