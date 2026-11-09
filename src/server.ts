import { serve } from "@hono/node-server";
import { bootFromEnv } from "./boot.js";
import { handleGeoCli } from "./geo/cli.js";

const geoCli = await handleGeoCli(process.argv.slice(2));
if (geoCli.handled) process.exit(geoCli.code);

const { app } = await bootFromEnv();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Infinitum revenue API on http://localhost:${port}`));
