/**
 * Cumulus ID (id.cumuluscloud.app) access tokens as a second way to call the customer API.
 *
 * Product apps sign people in with Cumulus ID and pass the user's access token as
 * `Authorization: Bearer <token>`. The token is verified against the issuer's JWKS
 * (RS256 / ES256, WebCrypto only, so it runs on Node and Cloudflare Workers alike).
 * Each Cumulus ID subject gets its own billing org on first use.
 */

export interface CidClaims { sub: string; email?: string; name?: string }
export type CidVerifier = (token: string) => Promise<CidClaims | null>;

export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

const b64url = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

export const looksLikeJwt = (t: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t);

export function createCidVerifier(opts: {
  issuer: string;
  /** When set, the token's `aud` or `azp` must include one of these client ids. */
  audiences?: string[];
  fetch?: typeof fetch;
  /** JWKS cache lifetime. */
  ttlMs?: number;
  now?: () => number;
}): CidVerifier {
  const issuer = opts.issuer.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; keys: Jwk[] } | null = null;

  const keys = async (force = false): Promise<Jwk[]> => {
    if (!force && cache && now() - cache.at < ttl) return cache.keys;
    const res = await doFetch(`${issuer}/protocol/openid-connect/certs`);
    if (!res.ok) throw new Error(`Cumulus ID JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    cache = { at: now(), keys: body.keys ?? [] };
    return cache.keys;
  };

  const importKey = (jwk: Jwk, alg: string) =>
    alg === "RS256"
      ? crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      : crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

  return async (token) => {
    if (!looksLikeJwt(token)) return null;
    const [h, p, s] = token.split(".");
    let header: any, payload: any;
    try { header = json(h); payload = json(p); } catch { return null; }
    const alg = header.alg;
    if (alg !== "RS256" && alg !== "ES256") return null;

    let jwk = (await keys()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid); // key rotation
    if (!jwk) return null;

    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64url(s);
    const ok = alg === "RS256"
      ? await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await importKey(jwk, alg), sig, data)
      : await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(jwk, alg), sig, data);
    if (!ok) return null;

    const t = Math.floor(now() / 1000);
    if (payload.iss !== issuer) return null;
    if (typeof payload.exp !== "number" || payload.exp < t - 30) return null;
    if (typeof payload.nbf === "number" && payload.nbf > t + 30) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (opts.audiences?.length) {
      const aud = [payload.azp, ...(Array.isArray(payload.aud) ? payload.aud : [payload.aud])].filter(Boolean);
      if (!aud.some((a: string) => opts.audiences!.includes(a))) return null;
    }
    return {
      sub: payload.sub,
      email: payload.email_verified === false ? undefined : payload.email,
      name: payload.name ?? payload.preferred_username,
    };
  };
}
