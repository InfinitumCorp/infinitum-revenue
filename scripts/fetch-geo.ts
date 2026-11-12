// Download pinned v2fly geoip.dat and geosite.dat. Fails closed on checksum mismatch.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGeoDatasets, type GeoLock } from "../src/geo/fetch.js";
import { geoDataDir } from "../src/geo/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(root, "geo-lock.json"), "utf8")) as GeoLock;
const dest = geoDataDir();

try {
  const wrote = await fetchGeoDatasets({ lock, destDir: dest });
  for (const file of wrote) console.log(`${file.filename} ${file.sha256} ok`);
  console.log(`geo datasets written to ${dest}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
