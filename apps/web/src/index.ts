export * from "./render.js";
export * from "./server.js";

import { pathToFileURL } from "node:url";
import { startWebServer } from "./server.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWebServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4008),
    reportsDir: process.env.CHROMA_SNAP_REPORT_DIR ?? ".chroma-snap/report",
  })
    .then(({ url }) => console.log(`Chroma Snap web review UI listening on ${url}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
