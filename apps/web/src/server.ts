import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ComparisonReport } from "@chroma-snap/shared";
import { renderReportHtml } from "./render.js";

export interface WebServerOptions {
  host?: string;
  port?: number;
  reportsDir?: string;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4008;
  const reportsDir = resolve(options.reportsDir ?? ".chroma-snap/report");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/healthz") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/" || url.pathname === "/report") {
        const report = JSON.parse(await readFile(resolve(reportsDir, "comparison-report.json"), "utf8")) as ComparisonReport;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(renderReportHtml(report));
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}
