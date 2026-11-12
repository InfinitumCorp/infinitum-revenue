import { readPersistedGeoRouting, resolveGeoEnabled, writePersistedGeoRouting, geoSettingsPath } from "./settings.js";

export interface GeoCliResult { handled: boolean; code: number }

export interface GeoCliOptions {
  settingsPath?: string;
  basePath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `--geo-routing on|off|status` persists the user-facing toggle and exits.
 * Returns `handled: false` when the flag is absent so the server starts as usual.
 */
export async function handleGeoCli(argv: string[], opts: GeoCliOptions = {}): Promise<GeoCliResult> {
  const eq = argv.find((arg) => arg.startsWith("--geo-routing="));
  const index = argv.indexOf("--geo-routing");
  if (!eq && index === -1) return { handled: false, code: 0 };

  const log = opts.log ?? ((line) => console.log(line));
  const err = opts.err ?? ((line) => console.error(line));
  const settingsPath = opts.settingsPath ?? geoSettingsPath(opts.env);
  const value = eq ? eq.slice("--geo-routing=".length) : argv[index + 1];
  if (!value || value.startsWith("--")) {
    err("usage: --geo-routing on|off|status");
    return { handled: true, code: 1 };
  }

  const norm = value.toLowerCase();
  if (norm === "status") {
    const persisted = await readPersistedGeoRouting({ base: opts.basePath, overlay: settingsPath });
    const env = opts.env ?? process.env;
    const resolved = resolveGeoEnabled(env, persisted);
    const shown = env.INFINITUM_GEO_ENABLED?.trim() ? env.INFINITUM_GEO_ENABLED : "unset";
    log(`geo-routing persisted: ${persisted ? "on" : "off"} (${settingsPath})`);
    log(`INFINITUM_GEO_ENABLED: ${shown}`);
    log(`geo-routing resolved: ${resolved ? "on" : "off"}`);
    log("Geo routing annotates product calls for cyber review. Default off.");
    return { handled: true, code: 0 };
  }
  if (norm !== "on" && norm !== "off") {
    err("geo-routing must be on, off, or status");
    return { handled: true, code: 1 };
  }
  await writePersistedGeoRouting(norm === "on", settingsPath);
  log(`geo-routing persisted: ${norm} (${settingsPath})`);
  return { handled: true, code: 0 };
}
