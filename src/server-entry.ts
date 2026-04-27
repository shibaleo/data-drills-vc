// Module-load trace at the very top so cold-start visibility doesn't depend
// on subsequent imports succeeding.
const _bootStart = Date.now();
console.log("[boot] server-entry: module load start", {
  iso: new Date().toISOString(),
  node: process.version,
  cwd: process.cwd(),
});

process.on("unhandledRejection", (reason) => {
  console.error("[boot] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[boot] uncaughtException:", err);
});

import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import app from "@/lib/hono-app";

console.log("[boot] server-entry: imports done", {
  elapsedMs: Date.now() - _bootStart,
});

/**
 * Vercel Node runtime calls `(req, res)` Node-style with IncomingMessage —
 * not a Web standard Request. The official `hono/vercel` `handle()` wrapper
 * just does `app.fetch(req)` which mis-types IncomingMessage as Request and
 * leads to a 404 (URL parsing fails) plus a 5-minute hang (Vercel waits for
 * res.end() that never comes when we return a Response). So we adapt
 * manually: IncomingMessage → fetch Request → app.fetch → write Response
 * back to ServerResponse.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const t0 = Date.now();
  const reqUrl = req.url || "/";
  const reqMethod = req.method || "GET";
  console.log("[handler] received", { url: reqUrl, method: reqMethod });

  try {
    // Reconstruct full URL from host header (Vercel always provides it).
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const url = new URL(reqUrl, `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    let body: Uint8Array | undefined;
    if (reqMethod !== "GET" && reqMethod !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
    }

    const request = new Request(url.toString(), {
      method: reqMethod,
      headers,
      ...(body ? { body } : {}),
    });

    const response = await app.fetch(request);
    console.log("[handler] app.fetch returned", {
      status: response.status,
      ms: Date.now() - t0,
    });

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      // setHeader is per-name; multiple set-cookie etc. arrive as one CSV header here.
      res.setHeader(key, value);
    });

    const arrayBuffer = await response.arrayBuffer();
    res.end(arrayBuffer.byteLength ? Buffer.from(arrayBuffer) : undefined);
    console.log("[handler] response sent", {
      bytes: arrayBuffer.byteLength,
      totalMs: Date.now() - t0,
    });
  } catch (e) {
    console.error("[handler] error", {
      ms: Date.now() - t0,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : e,
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    try {
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    } catch {
      // res may already be closed; nothing else we can do
    }
  }
}
