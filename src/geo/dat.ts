import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeText, scanFields } from "./protobuf.js";

/**
 * v2ray domain types (domain-list-community / v2fly geosite).
 * Plain = substring, Regex = regular expression, Domain = apex and subdomains, Full = exact host.
 */
const DOMAIN_PLAIN = 0;
const DOMAIN_REGEX = 1;
const DOMAIN_SUFFIX = 2;
const DOMAIN_FULL = 3;

interface Cidr { ip: Uint8Array; prefix: number }
interface ReverseEntry { country: string; cidrs: Cidr[] }

interface Inner {
  v4: Map<number, string>[];
  v6: Map<string, string>[];
  reverse: ReverseEntry[];
  order: string[];
  full: Map<string, string[]>;
  suffix: Map<string, string[]>;
  plain: { value: string; code: string }[];
  regex: { re: RegExp; code: string }[];
  skippedRegex: number;
}

export class GeoIndex {
  readonly skippedRegex: number;

  constructor(private readonly inner: Inner) {
    this.skippedRegex = inner.skippedRegex;
  }

  /** Country code for an IP, or null when nothing matches. Longest prefix wins. */
  lookupIp(ip: string): string | null {
    const bytes = parseIp(ip);
    if (!bytes) return null;
    if (bytes.length === 4) {
      const n = readU32(bytes);
      for (let prefix = 32; prefix >= 0; prefix--) {
        const hit = this.inner.v4[prefix].get(maskU32(n, prefix));
        if (hit) return hit;
      }
    } else {
      for (let prefix = 128; prefix >= 0; prefix--) {
        const hit = this.inner.v6[prefix].get(maskedKey(bytes, prefix));
        if (hit) return hit;
      }
    }
    for (const entry of this.inner.reverse) {
      const inside = entry.cidrs.some((cidr) => prefixMatch(bytes, cidr.ip, cidr.prefix));
      if (!inside) return entry.country;
    }
    return null;
  }

  /** Category codes whose rules match the domain, in dataset order. */
  lookupDomain(domain: string): string[] {
    const host = normalizeHost(domain);
    if (!host) return [];
    const hit = new Set<string>();
    const add = (codes: string[] | undefined) => {
      if (!codes) return;
      for (const code of codes) hit.add(code);
    };
    add(this.inner.full.get(host));
    const labels = host.split(".");
    for (let i = 0; i < labels.length; i++) add(this.inner.suffix.get(labels.slice(i).join(".")));
    for (const rule of this.inner.plain) if (host.includes(rule.value)) hit.add(rule.code);
    for (const rule of this.inner.regex) {
      rule.re.lastIndex = 0;
      if (rule.re.test(host)) hit.add(rule.code);
    }
    return this.inner.order.filter((code) => hit.has(code));
  }
}

function emptyInner(): Inner {
  return {
    v4: Array.from({ length: 33 }, () => new Map<number, string>()),
    v6: Array.from({ length: 129 }, () => new Map<string, string>()),
    reverse: [],
    order: [],
    full: new Map(),
    suffix: new Map(),
    plain: [],
    regex: [],
    skippedRegex: 0,
  };
}

export function emptyGeoIndex(): GeoIndex {
  return new GeoIndex(emptyInner());
}

export function loadGeoFromBuffers(geoip: Uint8Array, geosite: Uint8Array): GeoIndex {
  const inner = emptyInner();
  scanFields(geoip, (field, _wire, _varint, bytes) => {
    if (field === 1 && bytes) addGeoIp(inner, bytes);
  });
  scanFields(geosite, (field, _wire, _varint, bytes) => {
    if (field === 1 && bytes) addGeoSite(inner, bytes);
  });
  return new GeoIndex(inner);
}

let cached: { dir: string; index: GeoIndex } | null = null;

/** Load `geoip.dat` and `geosite.dat` from a directory. Successful loads are cached per directory. */
export async function loadGeoDatasets(dir: string): Promise<GeoIndex> {
  if (cached?.dir === dir) return cached.index;
  const geoip = await readFile(path.join(dir, "geoip.dat"));
  const geosite = await readFile(path.join(dir, "geosite.dat"));
  const index = loadGeoFromBuffers(geoip, geosite);
  cached = { dir, index };
  return index;
}

/** Drop the in-process dataset cache. Tests use this between directories. */
export function clearGeoCache(): void {
  cached = null;
}

function addGeoIp(inner: Inner, message: Uint8Array): void {
  let country = "";
  const cidrs: Cidr[] = [];
  let reverse = false;
  scanFields(message, (field, wire, varint, bytes) => {
    if (field === 1 && bytes) country = decodeText(bytes);
    else if (field === 2 && bytes) {
      const cidr = parseCidr(bytes);
      if (cidr) cidrs.push(cidr);
    } else if (field === 3 && wire === 0) reverse = varint !== 0n;
  });
  if (!country) return;
  if (reverse) {
    inner.reverse.push({ country, cidrs });
    return;
  }
  for (const cidr of cidrs) {
    if (cidr.ip.length === 4) {
      const slot = inner.v4[cidr.prefix];
      const network = maskU32(readU32(cidr.ip), cidr.prefix);
      if (!slot.has(network)) slot.set(network, country);
    } else if (cidr.ip.length === 16) {
      const slot = inner.v6[cidr.prefix];
      const network = maskedKey(cidr.ip, cidr.prefix);
      if (!slot.has(network)) slot.set(network, country);
    }
  }
}

function parseCidr(message: Uint8Array): Cidr | null {
  const found: { ip: Uint8Array | null; prefix: number | null } = { ip: null, prefix: null };
  scanFields(message, (field, wire, varint, bytes) => {
    if (field === 1 && bytes && (bytes.length === 4 || bytes.length === 16)) found.ip = Uint8Array.from(bytes);
    else if (field === 2 && wire === 0) found.prefix = Number(varint);
  });
  const ip = found.ip;
  if (!ip) return null;
  const bits = ip.length * 8;
  const raw = found.prefix === null ? bits : found.prefix;
  return { ip, prefix: Math.max(0, Math.min(bits, raw)) };
}

function addGeoSite(inner: Inner, message: Uint8Array): void {
  let code = "";
  const domains: Uint8Array[] = [];
  scanFields(message, (field, _wire, _varint, bytes) => {
    if (field === 1 && bytes) code = decodeText(bytes).trim();
    else if (field === 2 && bytes) domains.push(bytes);
  });
  if (!code) return;
  if (!inner.order.includes(code)) inner.order.push(code);
  for (const domain of domains) addDomain(inner, code, domain);
}

function addDomain(inner: Inner, code: string, message: Uint8Array): void {
  let type = DOMAIN_PLAIN;
  let value = "";
  scanFields(message, (field, wire, varint, bytes) => {
    if (field === 1 && wire === 0) type = Number(varint);
    else if (field === 2 && bytes) value = decodeText(bytes);
  });
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return;
  if (type === DOMAIN_PLAIN) inner.plain.push({ value: host, code });
  else if (type === DOMAIN_REGEX) {
    try { inner.regex.push({ re: new RegExp(value), code }); }
    catch { inner.skippedRegex++; }
  } else if (type === DOMAIN_SUFFIX) pushCode(inner.suffix, host, code);
  else if (type === DOMAIN_FULL) pushCode(inner.full, host, code);
}

function pushCode(map: Map<string, string[]>, key: string, code: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [code]);
  else if (!list.includes(code)) list.push(code);
}

export function normalizeHost(domain: string): string | null {
  let host = domain.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes(":") || host.includes("/")) return null;
  return host;
}

/** Parse an IPv4 or IPv6 address. IPv4-mapped `::ffff:a.b.c.d` is returned as 4 bytes. */
export function parseIp(input: string): Uint8Array | null {
  let value = input.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return parseV4(mapped[1]);
  if (value.includes(":")) return parseV6(value);
  return parseV4(value);
}

function parseV4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(value: string): Uint8Array | null {
  if (value.includes(":::")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = expandGroups(halves[0] ? halves[0].split(":") : []);
  const tail = expandGroups(halves.length === 2 && halves[1] ? halves[1].split(":") : []);
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? groupsToBytes(head) : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return groupsToBytes([...head, ...Array(missing).fill(0), ...tail]);
}

function expandGroups(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const v4 = parseV4(part);
      if (!v4) return null;
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

function groupsToBytes(groups: number[]): Uint8Array {
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    out[i * 2] = (group >> 8) & 0xff;
    out[i * 2 + 1] = group & 0xff;
  });
  return out;
}

function readU32(bytes: Uint8Array): number {
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
}

function maskU32(ip: number, prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return ip >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0;
}

function maskedKey(bytes: Uint8Array, prefix: number): string {
  const out = Buffer.alloc(bytes.length);
  const full = Math.min(bytes.length, Math.floor(prefix / 8));
  out.set(bytes.subarray(0, full));
  const rem = prefix % 8;
  if (rem && full < bytes.length) out[full] = bytes[full] & ((0xff << (8 - rem)) & 0xff);
  return out.toString("hex");
}

function prefixMatch(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  if (ip.length !== network.length) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full && i < ip.length; i++) if (ip[i] !== network[i]) return false;
  const rem = prefix % 8;
  if (!rem || full >= ip.length) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (ip[full] & mask) === (network[full] & mask);
}
