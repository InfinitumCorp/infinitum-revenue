import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GeoLockAsset {
  id: string;
  filename: string;
  /** Name inside the official .sha256sum asset (dlc.dat is saved as geosite.dat). */
  asset: string;
  tag: string;
  project: string;
  license: string;
  url: string;
  sha256sumUrl: string;
  sha256: string;
}

export interface GeoLock {
  vendor: string;
  note?: string;
  assets: GeoLockAsset[];
}

const BANNED = /loyalsoldier|sing-box|singbox/i;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Pull the hex digest for `assetName` out of a coreutils-style sha256sum file. */
export function parseSha256sum(text: string, assetName: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`official sha256sum has no entry for ${assetName}`);
}

export function assertV2flyUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error(`invalid dataset URL: ${url}`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error(`refusing URL outside https://github.com: ${url}`);
  }
  if (BANNED.test(url)) throw new Error(`refusing GPL-3 dataset URL: ${url}`);
}

export interface FetchedGeoFile { filename: string; sha256: string }

/**
 * Download the locked v2fly datasets. Each file is checked against its official
 * `.sha256sum` asset and the lockfile digest. On any mismatch nothing new is installed.
 */
export async function fetchGeoDatasets(opts: {
  lock: GeoLock;
  destDir: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchedGeoFile[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (opts.lock.vendor !== "v2fly") throw new Error("geo lock vendor must be v2fly");
  const ready: { filename: string; bytes: Uint8Array; sha256: string }[] = [];
  for (const asset of opts.lock.assets) {
    const identity = `${asset.url} ${asset.sha256sumUrl} ${asset.project} ${asset.filename} ${asset.asset}`;
    if (BANNED.test(identity)) throw new Error("refusing GPL-3 dataset (Loyalsoldier and sing-box are not used)");
    assertV2flyUrl(asset.url);
    assertV2flyUrl(asset.sha256sumUrl);
    const sumRes = await fetchImpl(asset.sha256sumUrl);
    if (!sumRes.ok) throw new Error(`sha256sum download failed (${sumRes.status}) for ${asset.sha256sumUrl}`);
    const official = parseSha256sum(await sumRes.text(), asset.asset);
    const locked = asset.sha256.trim().toLowerCase();
    if (official !== locked) {
      throw new Error(`checksum mismatch for ${asset.filename}: official sha256sum ${official} does not match lockfile ${locked}`);
    }
    const binRes = await fetchImpl(asset.url);
    if (!binRes.ok) throw new Error(`download failed (${binRes.status}) for ${asset.url}`);
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    const actual = sha256Hex(bytes);
    if (actual !== official) {
      throw new Error(`checksum mismatch for ${asset.filename}: downloaded ${actual}, official sha256sum ${official}`);
    }
    ready.push({ filename: asset.filename, bytes, sha256: actual });
  }

  await mkdir(opts.destDir, { recursive: true });
  const wrote: FetchedGeoFile[] = [];
  for (const item of ready) {
    const partial = path.join(opts.destDir, `${item.filename}.partial`);
    const finalPath = path.join(opts.destDir, item.filename);
    try {
      await writeFile(partial, item.bytes);
      const confirmed = sha256Hex(await readFile(partial));
      if (confirmed !== item.sha256) {
        throw new Error(`checksum mismatch for ${item.filename} after write: ${confirmed}, expected ${item.sha256}`);
      }
      await rename(partial, finalPath);
      wrote.push({ filename: item.filename, sha256: item.sha256 });
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }
  return wrote;
}
