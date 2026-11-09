/**
 * Standard (free) reCAPTCHA server-side check. This calls
 * https://www.google.com/recaptcha/api/siteverify, the endpoint shared by
 * reCAPTCHA v2 and v3. It does not call reCAPTCHA Enterprise and does not use
 * a billed assessment API.
 *
 * Verification is off unless a secret is configured. Callers then behave
 * exactly as they did before this check existed.
 */

/** Free reCAPTCHA v2/v3 siteverify. Not the Enterprise assessments API. */
export const RECAPTCHA_SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

/**
 * v3 responses include a score (1.0 human … 0.0 bot) and `success: true` for
 * any valid token. v2 responses have no score; a passing challenge is `success`.
 * Scores below this are rejected. v2 is unaffected.
 */
export const RECAPTCHA_V3_MIN_SCORE = 0.5;

const TOKEN_MAX = 4096;
const BODY_MAX = 10_000;
const TIMEOUT_MS = 5_000;

export type RecaptchaVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 503; code: "recaptcha_required" | "recaptcha_failed" | "recaptcha_unavailable"; message: string };

const required: RecaptchaVerdict = { ok: false, status: 400, code: "recaptcha_required", message: "reCAPTCHA token required" };
const failed: RecaptchaVerdict = { ok: false, status: 403, code: "recaptcha_failed", message: "reCAPTCHA verification failed" };
const unavailable: RecaptchaVerdict = { ok: false, status: 503, code: "recaptcha_unavailable", message: "reCAPTCHA verification unavailable" };

/** Header `X-Recaptcha-Token`, otherwise JSON `recaptchaToken`. */
export function recaptchaToken(header: string | undefined, body: unknown): string | undefined {
  const fromHeader = header?.trim();
  if (fromHeader) return fromHeader;
  if (!body || typeof body !== "object" || !("recaptchaToken" in body)) return undefined;
  const value = (body as { recaptchaToken?: unknown }).recaptchaToken;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Cloudflare's connecting IP, else the first X-Forwarded-For hop. */
export function clientIp(cfConnectingIp: string | undefined, xForwardedFor: string | undefined): string | undefined {
  const raw = (cfConnectingIp ?? xForwardedFor?.split(",")[0])?.trim();
  if (!raw || raw.length > 64 || /\s/.test(raw)) return undefined;
  return raw;
}

export async function verifyRecaptcha(opts: {
  secret: string | undefined;
  token: string | undefined;
  remoteIp?: string;
  /** Defaults to global fetch. Tests pass a stub; production always posts to the fixed siteverify URL. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  minScore?: number;
}): Promise<RecaptchaVerdict> {
  const secret = opts.secret?.trim() ?? "";
  if (!secret) return { ok: true };

  const token = opts.token?.trim() ?? "";
  if (!token) return required;
  if (token.length > TOKEN_MAX) return failed;

  const params = new URLSearchParams({ secret, response: token });
  if (opts.remoteIp) params.set("remoteip", opts.remoteIp);

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(RECAPTCHA_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error("recaptcha siteverify request failed", err instanceof Error ? err.name : "error");
    return unavailable;
  }

  if (!res.ok) {
    console.error("recaptcha siteverify http", res.status);
    return unavailable;
  }

  let text: string;
  try { text = await res.text(); }
  catch { return unavailable; }
  if (text.length > BODY_MAX) return unavailable;

  let data: { success?: unknown; score?: unknown; "error-codes"?: unknown };
  try { data = JSON.parse(text) as typeof data; }
  catch { return unavailable; }

  if (data.success !== true) {
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].filter((c) => typeof c === "string") : [];
    if (codes.length) console.error("recaptcha siteverify rejected", codes.join(","));
    return failed;
  }

  const minScore = opts.minScore ?? RECAPTCHA_V3_MIN_SCORE;
  if (data.score !== undefined) {
    if (typeof data.score !== "number" || !Number.isFinite(data.score) || data.score < minScore) return failed;
  }
  return { ok: true };
}
