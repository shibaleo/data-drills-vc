// Module-load trace lives at the very top so we can see in Vercel logs
// whether the function bundle even loads on cold start.
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

import { handle } from "hono/vercel";
import app from "@/lib/hono-app";

console.log("[boot] server-entry: imports done", {
  elapsedMs: Date.now() - _bootStart,
});

const handler = handle(app);
export default handler;
