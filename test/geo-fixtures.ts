/** Tiny synthetic v2ray GeoIPList / GeoSiteList payloads for tests. Not the v2fly releases. */

function encodeVarint(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) throw new Error("varint must be a non-negative integer");
  const bytes: number[] = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

const tag = (field: number, wire: number) => encodeVarint((field << 3) | wire);
const lenDelim = (field: number, body: Buffer) => Buffer.concat([tag(field, 2), encodeVarint(body.length), body]);
const varintField = (field: number, value: number) => Buffer.concat([tag(field, 0), encodeVarint(value)]);
const strField = (field: number, value: string) => lenDelim(field, Buffer.from(value, "utf8"));

function cidr(ip: Buffer, prefix: number): Buffer {
  return Buffer.concat([lenDelim(1, ip), varintField(2, prefix)]);
}

function geoip(code: string, cidrs: Buffer[], reverse = false): Buffer {
  const parts = [strField(1, code), ...cidrs.map((item) => lenDelim(2, item))];
  if (reverse) parts.push(varintField(3, 1));
  return Buffer.concat(parts);
}

function domain(type: number, value: string, attributes: Buffer[] = []): Buffer {
  return Buffer.concat([
    varintField(1, type),
    strField(2, value),
    ...attributes.map((item) => lenDelim(3, item)),
  ]);
}

function geosite(code: string, domains: Buffer[]): Buffer {
  return Buffer.concat([strField(1, code), ...domains.map((item) => lenDelim(2, item))]);
}

/** Synthetic geoip.dat: private, us, cn (longer prefix), jp, and a reverse "other" list. */
export function geoipFixture(): Buffer {
  const list = Buffer.concat([
    lenDelim(1, geoip("private", [cidr(Buffer.from([10, 0, 0, 0]), 8)])),
    lenDelim(1, geoip("us", [cidr(Buffer.from([1, 2, 3, 0]), 24)])),
    lenDelim(1, geoip("cn", [cidr(Buffer.from([1, 2, 3, 4]), 32)])),
    lenDelim(1, geoip("jp", [cidr(Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 32)])),
    lenDelim(1, geoip("other", [cidr(Buffer.from([192, 168, 0, 0]), 16)], true)),
    varintField(15, 1),
  ]);
  return list;
}

/** Synthetic geosite.dat: domain, plain, full, regex, a bad regex, and another plain rule. */
export function geositeFixture(): Buffer {
  const attribute = domain(0, "ignored-attr");
  const list = Buffer.concat([
    lenDelim(1, geosite("google", [domain(2, "google.com", [attribute])])),
    lenDelim(1, geosite("ads", [domain(0, "doubleclick")])),
    lenDelim(1, geosite("cn", [domain(3, "example.cn")])),
    lenDelim(1, geosite("news", [domain(1, "^news\\.")])),
    lenDelim(1, geosite("broken", [domain(1, "[")])),
    lenDelim(1, geosite("keyword", [domain(0, "google")])),
  ]);
  return list;
}
