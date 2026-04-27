/**
 * PDF Export — Vercel Function inline implementation.
 *
 * Loads problem files from Drive, extracts the configured pages with a
 * subject_level_code label, and returns the merged PDF as the response body.
 *
 * Auth is handled by the parent Hono app's `authenticate` middleware.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { problem, problemFile, oauthToken, subject, level } from "@/lib/db/schema";
import { getValidAccessToken } from "@/lib/google-oauth";
import { downloadDriveFile } from "@/lib/drive-helpers";
import { extractAndLabel, mergePdfs } from "@/lib/pdf-processing";

export const pdfExportInputSchema = z.object({
  problem_ids: z.array(z.string().uuid()).min(1),
});

/** Run async tasks with concurrency limit. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function getDriveAccessToken(): Promise<string> {
  const [tokens] = await db
    .select()
    .from(oauthToken)
    .where(eq(oauthToken.provider, "google"))
    .limit(1);
  if (!tokens) throw new Error("Google Drive not connected");
  return getValidAccessToken({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires_at: tokens.tokenExpiresAt,
  });
}

const app = new Hono()
  /**
   * GET /health — kept for client compatibility (`exportPhase = "waking"`).
   * On Vercel cold start is sub-second, so this just returns OK immediately.
   */
  .get("/health", (c) => c.json({ ok: true }))
  .post("/", zValidator("json", pdfExportInputSchema), async (c) => {
    const { problem_ids } = c.req.valid("json");
    const t0 = Date.now();
    console.log("[pdf] start", { count: problem_ids.length });

    const accessToken = await getDriveAccessToken();
    console.log("[pdf] got access token", { elapsedMs: Date.now() - t0 });

    const tDb = Date.now();
    const problems = await db
      .select()
      .from(problem)
      .where(inArray(problem.id, problem_ids));
    const files = await db
      .select()
      .from(problemFile)
      .where(inArray(problemFile.problemId, problem_ids));
    console.log("[pdf] loaded problems+files", {
      problems: problems.length,
      files: files.length,
      ms: Date.now() - tDb,
    });

    const subjectIds = [
      ...new Set(problems.map((p) => p.subjectId).filter(Boolean)),
    ] as string[];
    const levelIds = [
      ...new Set(problems.map((p) => p.levelId).filter(Boolean)),
    ] as string[];
    const subjectMap = new Map(
      subjectIds.length
        ? (
            await db.select().from(subject).where(inArray(subject.id, subjectIds))
          ).map((s) => [s.id, s.name])
        : [],
    );
    const levelMap = new Map(
      levelIds.length
        ? (
            await db.select().from(level).where(inArray(level.id, levelIds))
          ).map((l) => [l.id, l.name])
        : [],
    );

    problems.sort((a, b) => a.code.localeCompare(b.code));

    // Skip problems whose file has no explicit page list — the external
    // pipeline owns problem_pages population on every problem_file.
    const work = problems.flatMap((p) => {
      const pf = files.find((f) => f.problemId === p.id);
      if (!pf) return [];
      const pages = (pf.problemPages as number[]) ?? [];
      if (pages.length === 0) return [];
      const subName = (p.subjectId && subjectMap.get(p.subjectId)) || "";
      const lvlName = (p.levelId && levelMap.get(p.levelId)) || "";
      return [{ pf, label: `${subName}_${lvlName}_${p.code}`, pages }];
    });

    console.log("[pdf] work prepared", { items: work.length });

    const tDownload = Date.now();
    const parts = await pMap(
      work,
      async (w, i) => {
        const tw = Date.now();
        console.log(`[pdf] download ${i}/${work.length} fileId=${w.pf.gdriveFileId} pages=${w.pages.length}`);
        const raw = await downloadDriveFile(accessToken, w.pf.gdriveFileId);
        const buf = new Uint8Array(raw);
        const out = await extractAndLabel(buf, w.pages, w.label);
        console.log(`[pdf] download ${i} done in ${Date.now() - tw}ms (${out.byteLength}B)`);
        return out;
      },
      5,
    );
    console.log("[pdf] all downloads done", { ms: Date.now() - tDownload });

    if (parts.length === 0) {
      console.log("[pdf] no pages found, returning 404");
      return c.json({ error: "No problem pages found" }, 404);
    }

    const tMerge = Date.now();
    const merged = await mergePdfs(parts.map((p) => p.buffer as ArrayBuffer));
    console.log("[pdf] merged", {
      bytes: merged.byteLength,
      ms: Date.now() - tMerge,
      totalMs: Date.now() - t0,
    });
    const today = new Date().toISOString().slice(0, 10);

    return new Response(Buffer.from(merged), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="exported-${today}.pdf"`,
        "Content-Length": String(merged.byteLength),
      },
    });
  });

export default app;
