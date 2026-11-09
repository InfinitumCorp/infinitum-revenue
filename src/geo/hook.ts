import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { emptyGeoIndex, type GeoIndex } from "./dat.js";

/** Country and site categories attached to a product API call. Raw addresses are not stored. */
export interface GeoAnnotation {
  country: string | null;
  host: string | null;
  categories: string[];
}

/** Observe-only decision. Geo routing never blocks or rewrites a request. */
export interface GeoDecision {
  action: "annotate";
  log: boolean;
}

const current = new AsyncLocalStorage<GeoAnnotation>();

export function currentGeo(): GeoAnnotation | undefined {
  return current.getStore();
}

export function runWithGeo<T>(annotation: GeoAnnotation, fn: () => T): T {
  return current.run(annotation, fn);
}

export function annotateRequest(index: GeoIndex | undefined, input: { ip: string | null; host: string | null }): GeoAnnotation {
  const geo = index ?? emptyGeoIndex();
  const host = input.host ? input.host.toLowerCase() : null;
  return {
    country: input.ip ? geo.lookupIp(input.ip) : null,
    host,
    categories: host ? geo.lookupDomain(host) : [],
  };
}

/** Cyber policy for an annotated call: record country and category, then continue. */
export function geoPolicy(annotation: GeoAnnotation): GeoDecision {
  return { action: "annotate", log: annotation.categories !== undefined };
}

export function logGeo(annotation: GeoAnnotation, decision: GeoDecision): void {
  console.log(JSON.stringify({
    geo: { country: annotation.country, host: annotation.host, categories: annotation.categories },
    policy: decision.action,
  }));
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("cf-connecting-ip")?.trim()
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (!forwarded || forwarded.length > 64) return null;
  return forwarded;
}

function requestHost(c: Context): string | null {
  try { return new URL(c.req.url).hostname.toLowerCase(); }
  catch { return null; }
}

/**
 * Product-API hook. Registered only when geo routing is on, so the off path
 * keeps the previous middleware stack.
 */
export function geoMiddleware(index: GeoIndex | undefined): MiddlewareHandler {
  return async (c, next) => {
    let annotation: GeoAnnotation;
    try {
      annotation = annotateRequest(index, { ip: clientIp(c), host: requestHost(c) });
      const decision = geoPolicy(annotation);
      if (decision.log) logGeo(annotation, decision);
    } catch (err) {
      console.error(`geo annotation skipped: ${err instanceof Error ? err.message : err}`);
      return next();
    }
    return runWithGeo(annotation, () => next());
  };
}

/** Annotate a validated return host. Does not change the URL. */
export function noteReturnHost(ctx: { config: { geoEnabled?: boolean }; geo?: GeoIndex }, host: string): void {
  if (ctx.config.geoEnabled !== true || !ctx.geo) return;
  const annotation: GeoAnnotation = {
    country: null,
    host: host.toLowerCase(),
    categories: ctx.geo.lookupDomain(host),
  };
  const decision = geoPolicy(annotation);
  if (decision.log) logGeo(annotation, decision);
}
