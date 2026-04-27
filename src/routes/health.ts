import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const app = new Hono()
  /**
   * GET /health — fast liveness probe. Does NOT touch the DB so it can
   * confirm the function bundle loads even when the DB connection is broken.
   */
  .get("/", (c) =>
    c.json({
      status: "ok",
      env: {
        hasClerkPK: !!process.env.VITE_CLERK_PUBLISHABLE_KEY,
        hasClerkSK: !!process.env.CLERK_SECRET_KEY,
        hasDbUrl: !!process.env.DATABASE_URL,
        hasJwtSecret: !!process.env.JWT_SECRET,
        hasAdminApiKey: !!process.env.ADMIN_API_KEY,
        hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
        hasGoogleClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      },
      runtime: {
        node: process.version,
        cwd: process.cwd(),
      },
    }),
  )
  /**
   * GET /health/diag — deep probe: tries `SELECT 1` to validate that the DB
   * pool is reachable from the function. Times out fast so a hang is visible
   * in logs without holding the request open.
   */
  .get("/diag", async (c) => {
    const phases: Array<{ name: string; ms: number; ok: boolean; error?: string }> = [];

    const probe = async <T>(name: string, fn: () => Promise<T>) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        const ms = Date.now() - t0;
        phases.push({ name, ms, ok: true });
        console.log(`[diag] ${name} ok in ${ms}ms`);
        return r;
      } catch (e) {
        const ms = Date.now() - t0;
        const msg = e instanceof Error ? e.message : String(e);
        phases.push({ name, ms, ok: false, error: msg });
        console.error(`[diag] ${name} FAIL in ${ms}ms:`, msg);
        return null;
      }
    };

    await probe("db-select-1", async () => {
      const result = await Promise.race([
        db.execute(sql`select 1 as one`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 8s")), 8000)),
      ]);
      return result;
    });

    return c.json({
      status: phases.every((p) => p.ok) ? "ok" : "degraded",
      phases,
    });
  });

export default app;
