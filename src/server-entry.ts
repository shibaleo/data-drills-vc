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

import app from "@/lib/hono-app";

console.log("[boot] server-entry: imports done", {
  elapsedMs: Date.now() - _bootStart,
});

// Diagnostic handler — bypasses `hono/vercel` and calls app.fetch directly so
// we can see whether the request enters the handler at all and whether the
// response ever comes back. The previous deploy hung silently for 5 minutes
// after module load with no [req] log, suggesting handle(app) never invoked
// the Hono pipeline (likely a Vercel Request/handler-shape mismatch).
export default async function handler(request: Request): Promise<Response> {
  const t0 = Date.now();
  console.log("[handler] received request", {
    type: typeof request,
    hasUrl: typeof (request as any)?.url === "string",
    url: (request as any)?.url,
    method: (request as any)?.method,
    keys: request ? Object.keys(request).slice(0, 10) : null,
  });
  try {
    const response = await app.fetch(request);
    console.log("[handler] app.fetch returned", {
      status: response.status,
      ms: Date.now() - t0,
    });
    return response;
  } catch (e) {
    console.error("[handler] app.fetch threw", {
      ms: Date.now() - t0,
      error: e instanceof Error ? `${e.message}\n${e.stack}` : e,
    });
    throw e;
  }
}
