/**
 * Optional Always Free AWS adapters. Both stay off unless AWS_REGION and
 * access keys are set, and the matching setting is set too (SNS_TOPIC_ARN or
 * CLOUDWATCH_NAMESPACE). Nothing here reads STRIPE_* or verifies webhooks.
 *
 * SNS: Publish only, to an HTTPS topic. No Subscribe, no PhoneNumber, no
 * email/SMS protocol, no MessageStructure. Always Free covers 1,000,000
 * publishes and 100,000 HTTP/S deliveries a month; SMS is not free.
 * https://aws.amazon.com/free/serverless/
 *
 * CloudWatch: one PutMetricData batch for at most these three standard-resolution
 * custom metrics, with no dimensions (each dimension value would be another
 * metric toward the 10 that are Always Free).
 * https://aws.amazon.com/cloudwatch/pricing/
 */
import { AwsClient } from "aws4fetch";
import type { Ctx } from "./context.js";
import type { PaymentEvent } from "./payments.js";

/** Fixed set. Do not add names or dimensions; the free tier is 10 custom metrics. */
export const CLOUDWATCH_METRICS = ["WebhookProcessed", "WebhookFailed", "CheckoutCreated"] as const;
export type CloudWatchMetric = (typeof CLOUDWATCH_METRICS)[number];

const REGION = /^[a-z]{2}-[a-z]+-\d+$/;
const TOPIC = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d+):(\d{12}):[A-Za-z0-9_-]{1,256}$/;
const TIMEOUT_MS = 2_000;

export interface AwsSettings {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  snsTopicArn?: string;
  cloudWatchNamespace?: string;
}

export interface PaymentNotice {
  kind: string;
  eventId: string;
  duplicate: boolean;
  /** Identifier fields only. Amounts, metadata, and anything that looks like an email or card number are dropped. */
  ids: Record<string, string>;
}

export interface AwsHooks {
  paymentProcessed(notice: PaymentNotice): void;
  webhookFailed(): void;
  checkoutCreated(): void;
}

const ID_FIELDS = ["orgId", "planId", "status", "providerSubscriptionId", "sessionId", "paymentIntentId", "invoiceId", "purpose", "ref", "customerId", "type"] as const;

function asId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s || s.length > 200 || /[\r\n@]/.test(s) || /^(?:\d[ -]?){13,19}$/.test(s)) return undefined;
  return s;
}

/** Whitelist of ids from an already-verified payment event. */
export function paymentNotice(event: PaymentEvent, result?: { duplicate?: boolean }): PaymentNotice {
  const ids: Record<string, string> = {};
  const record = event as unknown as Record<string, unknown>;
  for (const key of ID_FIELDS) {
    if (key === "type" && event.kind !== "ignored") continue;
    const value = asId(record[key]);
    if (value) ids[key] = value;
  }
  return { kind: event.kind, eventId: asId(event.eventId) ?? "unknown", duplicate: !!result?.duplicate, ids };
}

/**
 * Returns settings only when region, credentials, and at least one adapter's
 * own config are all present and valid. Otherwise the caller leaves AWS off.
 */
export function readAwsConfig(env: NodeJS.ProcessEnv): AwsSettings | undefined {
  const region = env.AWS_REGION?.trim() ?? "";
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
  const sessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
  const topic = env.SNS_TOPIC_ARN?.trim() ?? "";
  const namespace = env.CLOUDWATCH_NAMESPACE?.trim() ?? "";
  if (!topic && !namespace) return undefined;

  if (!REGION.test(region) || !accessKeyId || !secretAccessKey) {
    console.warn("AWS_REGION and access keys are required before SNS or CloudWatch can turn on; leaving both off.");
    return undefined;
  }

  let snsTopicArn: string | undefined;
  if (topic) {
    const match = TOPIC.exec(topic);
    if (!match || match[1] !== region) console.warn("SNS_TOPIC_ARN must be an SNS topic in AWS_REGION; SNS fan-out left off.");
    else snsTopicArn = topic;
  }

  let cloudWatchNamespace: string | undefined;
  if (namespace) {
    if (namespace.length > 255 || /[\u0000-\u001f]/.test(namespace)) console.warn("CLOUDWATCH_NAMESPACE is invalid; CloudWatch metrics left off.");
    else cloudWatchNamespace = namespace;
  }

  if (!snsTopicArn && !cloudWatchNamespace) return undefined;
  return { region, accessKeyId, secretAccessKey, sessionToken, snsTopicArn, cloudWatchNamespace };
}

function later(ctx: Ctx, run: () => Promise<void>) {
  const safe = Promise.resolve().then(run).then(() => undefined, (err) => {
    console.error("aws background task failed", err instanceof Error ? err.name : "error");
  });
  (ctx.pending ??= []).push(safe);
}

/** Wait for best-effort AWS calls queued during this request. Never throws. */
export function drainAws(ctx: Ctx): Promise<void> {
  const batch = ctx.pending?.splice(0) ?? [];
  return Promise.all(batch).then(() => undefined);
}

function bindCheckouts(ctx: Ctx) {
  const pay = ctx.pay;
  const subscriptionCheckout = pay.subscriptionCheckout.bind(pay);
  const paymentCheckout = pay.paymentCheckout.bind(pay);
  pay.subscriptionCheckout = async (input) => {
    const session = await subscriptionCheckout(input);
    ctx.aws?.checkoutCreated();
    return session;
  };
  pay.paymentCheckout = async (input) => {
    const session = await paymentCheckout(input);
    ctx.aws?.checkoutCreated();
    return session;
  };
}

/**
 * Attaches SNS and CloudWatch when their env gates pass. Returns false when
 * left off. Checkout hooks count a session only after the provider returns it.
 */
export function attachAws(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): boolean {
  const settings = readAwsConfig(env);
  if (!settings) return false;

  const client = new AwsClient({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    sessionToken: settings.sessionToken,
    region: settings.region,
    retries: 0,
  });
  const counts = new Map<CloudWatchMetric, number>();
  let flushQueued = false;

  const post = async (service: "sns" | "monitoring", body: string) => {
    const host = service === "sns" ? "sns" : "monitoring";
    const signed = await client.sign(`https://${host}.${settings.region}.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      aws: { service, region: settings.region },
    });
    const res = await fetchImpl(signed);
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`aws ${service} http ${res.status}`);
  };

  const publish = (notice: PaymentNotice) => {
    const params = new URLSearchParams({
      Action: "Publish",
      Version: "2010-03-31",
      TopicArn: settings.snsTopicArn!,
      Message: JSON.stringify({ kind: notice.kind, eventId: notice.eventId, ...notice.ids }),
    });
    return post("sns", params.toString());
  };

  const flush = async () => {
    flushQueued = false;
    if (!settings.cloudWatchNamespace || counts.size === 0) return;
    const batch = [...counts.entries()];
    counts.clear();
    const params = new URLSearchParams({ Action: "PutMetricData", Version: "2010-08-01", Namespace: settings.cloudWatchNamespace });
    batch.forEach(([name, value], i) => {
      const n = i + 1;
      params.set(`MetricData.member.${n}.MetricName`, name);
      params.set(`MetricData.member.${n}.Value`, String(value));
      params.set(`MetricData.member.${n}.Unit`, "Count");
      params.set(`MetricData.member.${n}.StorageResolution`, "60");
    });
    await post("monitoring", params.toString());
  };

  const mark = (name: CloudWatchMetric) => {
    if (!settings.cloudWatchNamespace) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (flushQueued) return;
    flushQueued = true;
    later(ctx, flush);
  };

  ctx.aws = {
    paymentProcessed(notice) {
      mark("WebhookProcessed");
      if (settings.snsTopicArn && !notice.duplicate) later(ctx, () => publish(notice));
    },
    webhookFailed() { mark("WebhookFailed"); },
    checkoutCreated() { mark("CheckoutCreated"); },
  };
  if (settings.cloudWatchNamespace) bindCheckouts(ctx);
  return true;
}
