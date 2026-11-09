/** Minimal protobuf scanner for v2ray GeoIPList / GeoSiteList. No extra dependencies. */

const MAX_VARINT_BYTES = 10;

export function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= buf.length) throw new Error("truncated protobuf");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("protobuf varint too long");
}

export type FieldVisit = (field: number, wire: number, varint: bigint, bytes: Uint8Array | null) => void;

/** Walk a protobuf message. Unknown wire types 1 and 5 are skipped; groups are rejected. */
export function scanFields(buf: Uint8Array, visit: FieldVisit): void {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!Number.isSafeInteger(field) || field <= 0) throw new Error("invalid protobuf field");
    pos = afterTag;
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      visit(field, wire, value, null);
      pos = next;
    } else if (wire === 2) {
      const [len, body] = readVarint(buf, pos);
      if (len > BigInt(buf.length - body)) throw new Error("truncated protobuf");
      const n = Number(len);
      visit(field, wire, 0n, buf.subarray(body, body + n));
      pos = body + n;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error("truncated protobuf");
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error("truncated protobuf");
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

const text = new TextDecoder("utf-8", { fatal: false });

export function decodeText(bytes: Uint8Array): string {
  return text.decode(bytes);
}
