import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ENABLED = new Set(["1", "true", "on", "yes"]);

/** Runtime overlay written by `--geo-routing`. Git-ignored under `.data`. */
export function geoSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFINITUM_GEO_SETTINGS_PATH || path.join(process.cwd(), ".data", "geo-routing.json");
}

/** Shipped default. `geoRouting` is false. */
export function geoConfigPath(): string {
  return path.join(process.cwd(), "config", "settings.json");
}

export function geoDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFINITUM_GEO_DATA_DIR || path.join(process.cwd(), "data", "geo");
}

/**
 * `INFINITUM_GEO_ENABLED`, when set, forces the hook on or off.
 * When it is unset, the persisted geo-routing toggle is used. Both default off.
 */
export function resolveGeoEnabled(env: { INFINITUM_GEO_ENABLED?: string }, persisted: boolean): boolean {
  const raw = env.INFINITUM_GEO_ENABLED;
  if (raw === undefined || raw.trim() === "") return persisted;
  return ENABLED.has(raw.trim().toLowerCase());
}

export async function readPersistedGeoRouting(paths?: { base?: string; overlay?: string }): Promise<boolean> {
  const overlay = await readFlag(paths?.overlay ?? geoSettingsPath());
  if (overlay !== null) return overlay;
  const base = await readFlag(paths?.base ?? geoConfigPath());
  return base === true;
}

export async function writePersistedGeoRouting(on: boolean, file = geoSettingsPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ geoRouting: on }, null, 2)}\n`);
}

async function readFlag(file: string): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { geoRouting?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.geoRouting !== "boolean") return null;
    return parsed.geoRouting;
  } catch {
    return null;
  }
}
