import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, pgliteDb } from "../src/db.js";
import { AppError, type Ctx } from "../src/context.js";
import { loadGeoFromBuffers } from "../src/geo/dat.js";
import { assertV2flyUrl, fetchGeoDatasets, parseSha256sum, sha256Hex, type GeoLock } from "../src/geo/fetch.js";
import { handleGeoCli } from "../src/geo/cli.js";
import { readPersistedGeoRouting, resolveGeoEnabled, writePersistedGeoRouting } from "../src/geo/settings.js";
import { checkReturnUrl } from "../src/services/billing.js";
import { FakePayments } from "../src/payments.js";
import { geoipFixture, geositeFixture } from "./geo-fixtures.js";

const GEOIP_SHA = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE_SHA = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

const geoipBytes = new Uint8Array(geoipFixture());
const geositeBytes = new Uint8Array(geositeFixture());

function index() {
  return loadGeoFromBuffers(geoipBytes, geositeBytes);
}

describe("synthetic geo fixtures", () => {
  it("matches the committed .dat fixtures byte for byte", async () => {
    const geoip = await readFile(new URL("./fixtures/geoip.dat", import.meta.url));
    const geosite = await readFile(new URL("./fixtures/geosite.dat", import.meta.url));
    expect(Buffer.compare(geoip, geoipFixture())).toBe(0);
    expect(Buffer.compare(geosite, geositeFixture())).toBe(0);
    expect(geoip.byteLength).toBeLessThan(512);
    expect(geosite.byteLength).toBeLessThan(512);
  });

  it("maps an IP to a country, with the longest prefix winning", () => {
    const geo = index();
    expect(geo.lookupIp("1.2.3.4")).toBe("cn");
    expect(geo.lookupIp("1.2.3.5")).toBe("us");
    expect(geo.lookupIp("10.9.8.7")).toBe("private");
    expect(geo.lookupIp("::ffff:1.2.3.4")).toBe("cn");
    expect(geo.lookupIp("2001:db8::1")).toBe("jp");
    expect(geo.lookupIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("jp");
    expect(geo.lookupIp("192.168.1.1")).toBeNull();
    expect(geo.lookupIp("8.8.8.8")).toBe("other");
    expect(geo.lookupIp("2001:db9::1")).toBe("other");
    expect(geo.lookupIp("999.1.1.1")).toBeNull();
    expect(geo.lookupIp("not-an-ip")).toBeNull();
  });

  it("maps a domain to categories in dataset order", () => {
    const geo = index();
    expect(geo.skippedRegex).toBe(1);
    expect(geo.lookupDomain("www.google.com")).toEqual(["google", "keyword"]);
    expect(geo.lookupDomain("WWW.GOOGLE.COM.")).toEqual(["google", "keyword"]);
    expect(geo.lookupDomain("news.google.com")).toEqual(["google", "news", "keyword"]);
    expect(geo.lookupDomain("ads.doubleclick.net")).toEqual(["ads"]);
    expect(geo.lookupDomain("example.cn")).toEqual(["cn"]);
    expect(geo.lookupDomain("www.example.cn")).toEqual([]);
    expect(geo.lookupDomain("notgoogle.com")).toEqual(["keyword"]);
    expect(geo.lookupDomain("example.org")).toEqual([]);
    expect(geo.lookupDomain("")).toEqual([]);
  });

  it("rejects a truncated dataset", () => {
    expect(() => loadGeoFromBuffers(Uint8Array.of(0x0a, 0x05), geositeBytes)).toThrow(/truncated protobuf/);
  });
});

describe("geo lockfile and checksums", () => {
  it("pins the v2fly release assets and the official digests", async () => {
    const lock = JSON.parse(await readFile(new URL("../geo-lock.json", import.meta.url), "utf8")) as GeoLock;
    expect(lock.vendor).toBe("v2fly");
    for (const asset of lock.assets) {
      const identity = `${asset.url} ${asset.sha256sumUrl} ${asset.project} ${asset.filename} ${asset.asset}`.toLowerCase();
      expect(identity).not.toContain("loyalsoldier");
      expect(identity).not.toContain("sing-box");
      expect(identity).not.toContain("singbox");
    }
    expect(lock.assets.map((asset) => ({ file: asset.filename, asset: asset.asset, tag: asset.tag, sha256: asset.sha256 }))).toEqual([
      { file: "geoip.dat", asset: "geoip.dat", tag: "202611080027", sha256: GEOIP_SHA },
      { file: "geosite.dat", asset: "dlc.dat", tag: "20261108011013", sha256: GEOSITE_SHA },
    ]);
    expect(lock.assets[0].url).toBe("https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat");
    expect(lock.assets[1].url).toBe("https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat");
    expect(parseSha256sum(`${GEOIP_SHA}  geoip.dat\n`, "geoip.dat")).toBe(GEOIP_SHA);
    expect(parseSha256sum(`${GEOSITE_SHA} *dlc.dat\n`, "dlc.dat")).toBe(GEOSITE_SHA);
  });

  it("refuses anything other than the v2fly GitHub releases", async () => {
    expect(() => assertV2flyUrl("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat")).toThrow(/GPL-3/);
    expect(() => assertV2flyUrl("https://example.com/geoip.dat")).toThrow(/github.com/);
    const banned: GeoLock = {
      vendor: "v2fly",
      assets: [{ ...asset("geoip.dat", "geoip.dat", "ab".repeat(32)), project: "Loyalsoldier/v2ray-rules-dat" }],
    };
    await expect(fetchGeoDatasets({
      lock: banned,
      destDir: tmpdir(),
      fetchImpl: async () => { throw new Error("should not download"); },
    })).rejects.toThrow(/GPL-3/);
  });

  it("does not install files when a checksum does not match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geo-mismatch-"));
    await writeFile(path.join(dir, "geoip.dat"), Buffer.from("keep"));
    const body = new TextEncoder().encode("not-the-dataset");
    const hash = sha256Hex(body);
    const lock: GeoLock = {
      vendor: "v2fly",
      assets: [asset("geoip.dat", "geoip.dat", hash.replace(/^./, hash[0] === "a" ? "b" : "a"))],
    };
    const fetchImpl = mockFetch({
      [lock.assets[0].sha256sumUrl]: `${hash}  geoip.dat\n`,
      [lock.assets[0].url]: body,
    });
    await expect(fetchGeoDatasets({ lock, destDir: dir, fetchImpl })).rejects.toThrow(/checksum mismatch/);
    expect(await readFile(path.join(dir, "geoip.dat"), "utf8")).toBe("keep");
    expect(await readdir(dir)).toEqual(["geoip.dat"]);
  });

  it("installs only after the official sha256sum and the lockfile agree with the bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geo-ok-"));
    const geoip = new TextEncoder().encode("geoip-bytes");
    const geosite = new TextEncoder().encode("geosite-bytes");
    const lock: GeoLock = {
      vendor: "v2fly",
      assets: [
        asset("geoip.dat", "geoip.dat", sha256Hex(geoip)),
        asset("geosite.dat", "dlc.dat", sha256Hex(geosite)),
      ],
    };
    const fetchImpl = mockFetch({
      [lock.assets[0].sha256sumUrl]: `${lock.assets[0].sha256}  geoip.dat\n`,
      [lock.assets[0].url]: geoip,
      [lock.assets[1].sha256sumUrl]: `${lock.assets[1].sha256}  dlc.dat\n`,
      [lock.assets[1].url]: geosite,
    });
    const wrote = await fetchGeoDatasets({ lock, destDir: dir, fetchImpl });
    expect(wrote.map((file) => file.filename)).toEqual(["geoip.dat", "geosite.dat"]);
    expect(sha256Hex(await readFile(path.join(dir, "geosite.dat")))).toBe(lock.assets[1].sha256);
    expect(await readdir(dir)).not.toContain("geosite.dat.partial");
  });
});

describe("geo-routing toggle", () => {
  it("stays off unless the env or the persisted toggle says on", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geo-settings-"));
    const base = path.join(dir, "settings.json");
    const overlay = path.join(dir, "geo-routing.json");
    await writeFile(base, `${JSON.stringify({ geoRouting: false })}\n`);
    expect(await readPersistedGeoRouting({ base, overlay })).toBe(false);
    expect(resolveGeoEnabled({}, false)).toBe(false);
    expect(resolveGeoEnabled({ INFINITUM_GEO_ENABLED: "false" }, true)).toBe(false);
    expect(resolveGeoEnabled({ INFINITUM_GEO_ENABLED: "true" }, false)).toBe(true);

    const logs: string[] = [];
    const on = await handleGeoCli(["--geo-routing", "on"], { settingsPath: overlay, basePath: base, log: (line) => logs.push(line) });
    expect(on).toEqual({ handled: true, code: 0 });
    expect(await readPersistedGeoRouting({ base, overlay })).toBe(true);
    expect(resolveGeoEnabled({}, true)).toBe(true);

    const status = await handleGeoCli(["--geo-routing=status"], {
      settingsPath: overlay, basePath: base, env: {}, log: (line) => logs.push(line),
    });
    expect(status).toEqual({ handled: true, code: 0 });
    expect(logs.some((line) => line.includes("persisted: on"))).toBe(true);
    expect(logs.some((line) => line.includes("resolved: on"))).toBe(true);

    await writePersistedGeoRouting(false, overlay);
    expect(await readPersistedGeoRouting({ base, overlay })).toBe(false);
    expect(await handleGeoCli(["--geo-routing", "sideways"], { settingsPath: overlay, err: () => {} })).toEqual({ handled: true, code: 1 });
    expect(await readPersistedGeoRouting({ base, overlay })).toBe(false);
    expect(await handleGeoCli(["--help"])).toEqual({ handled: false, code: 0 });
    const shipped = JSON.parse(await readFile(new URL("../config/settings.json", import.meta.url), "utf8"));
    expect(shipped).toEqual({ geoRouting: false });
    const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
    expect(ignore).toContain("data/geo/");
  });
});

describe("product API hook", () => {
  afterEach(() => vi.restoreAllMocks());

  async function app(geoEnabled: boolean) {
    const db = await pgliteDb();
    await migrate(db);
    const geo = index();
    const ctx: Ctx = {
      db,
      pay: new FakePayments(),
      geo: geoEnabled ? geo : undefined,
      config: {
        publicUrl: "https://infinitum.test",
        returnHosts: ["rchtch.app"],
        adminApiKey: "a".repeat(40),
        tokenPayoutsEnabled: false,
        geoEnabled,
      },
    };
    return { ctx, db, app: createApp(ctx) };
  }

  it("leaves responses and landing pages unchanged when geo routing is off", async () => {
    const off = await app(false);
    const on = await app(true);
    const db = off.db;
    for (const route of ["/billing", "/billing/success", "/billing/cancelled"]) {
      expect(await (await off.app.request(route)).text()).toBe(await (await on.app.request(route)).text());
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => { logs.push(String(message)); });
    const res = await off.app.request("/v1/signup", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(201);
    const [row] = await db.query<{ detail: unknown }>("select detail from audit_log where action = 'org.created'");
    const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
    expect(detail).toEqual({ kind: "business" });
    expect(logs.some((line) => line.includes('"policy":"annotate"'))).toBe(false);
  });

  it("annotates and logs only when geo routing is on, without changing the return URL", async () => {
    const { ctx, db, app: on } = await app(true);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => { logs.push(String(message)); });
    const res = await on.request("http://www.google.com/v1/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { orgId: string; apiKey: string };
    expect(body.orgId).toMatch(/^org_/);
    expect(body.apiKey).toMatch(/^ik_/);
    const [row] = await db.query<{ detail: unknown }>("select detail from audit_log where action = 'org.created'");
    const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
    expect(detail.kind).toBe("business");
    expect(detail.geo).toEqual({ country: "cn", host: "www.google.com", categories: ["google", "keyword"] });
    expect(logs.some((line) => line.includes('"country":"cn"') && line.includes('"policy":"annotate"'))).toBe(true);

    const offCtx: Ctx = { ...ctx, geo: undefined, config: { ...ctx.config, geoEnabled: false } };
    const raw = "https://rchtch.app/settings";
    expect(checkReturnUrl(ctx, raw)!.toString()).toBe(checkReturnUrl(offCtx, raw)!.toString());
    expect(logs.some((line) => line.includes('"host":"rchtch.app"'))).toBe(true);
    expect(() => checkReturnUrl(ctx, "https://evil.example/phish")).toThrow(AppError);
  });
});

function asset(filename: string, name: string, sha256: string): GeoLock["assets"][number] {
  return {
    id: filename,
    filename,
    asset: name,
    tag: "test",
    project: "v2fly/geoip",
    license: "CC-BY-SA-4.0",
    url: `https://github.com/v2fly/geoip/releases/download/test/${name}`,
    sha256sumUrl: `https://github.com/v2fly/geoip/releases/download/test/${name}.sha256sum`,
    sha256,
  };
}

function mockFetch(files: Record<string, string | Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = files[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    const payload = typeof body === "string" ? body : Buffer.from(body);
    return new Response(payload);
  }) as typeof fetch;
}
