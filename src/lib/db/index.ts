/**
 * DB client for Vercel Functions (Node.js runtime).
 *
 * Vercel Functions run in long-lived Node processes (one per warm container)
 * so a module-scoped postgres client is reused across invocations. Each
 * invocation is short, the pool size is small, and Supabase's pooler handles
 * multiplexing — no AsyncLocalStorage indirection needed.
 *
 * DATABASE_URL is expected to be the Supabase pooler URL (transaction mode);
 * `prepare: false` keeps pgbouncer happy.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  _pgClient?: ReturnType<typeof postgres>;
};

console.log("[boot] db: module load", {
  hasDbUrl: !!process.env.DATABASE_URL,
  cached: !!globalForDb._pgClient,
});

const client =
  globalForDb._pgClient ??
  (() => {
    const t0 = Date.now();
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("[boot] db: DATABASE_URL is missing!");
    } else {
      // Surface only the pooler host so logs aren't sensitive.
      const safeHost = url.replace(/^postgresql:\/\/[^@]*@/, "postgresql://***@");
      console.log("[boot] db: creating new postgres client", { url: safeHost });
    }
    const c = postgres(url!, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      ssl: "require",
      onnotice: (n) => console.log("[db] notice:", n),
    });
    console.log("[boot] db: postgres() returned in", Date.now() - t0, "ms");
    return c;
  })();

if (process.env.NODE_ENV !== "production") {
  globalForDb._pgClient = client;
}
// On Vercel, also cache on globalThis so warm invocations skip re-creation.
globalForDb._pgClient = client;

export const db = drizzle(client, { schema });
