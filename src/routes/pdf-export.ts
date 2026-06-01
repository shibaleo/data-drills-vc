/**
 * PDF Export — in-process implementation (no proxy).
 *
 * vc は Vercel Functions 上で pdf-lib + fontkit を直接動かして PDF を結合する。
 * cf 版は Hyperdrive の制約で重い処理を Worker で回せないので Render の
 * services/pdf へ proxy するが、vc は Node 18 server full なので不要。
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/lib/db";
import { problem, problemFile, oauthToken, subject, level } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getValidAccessToken } from "@/lib/google-oauth";
import { downloadDriveFile } from "@/lib/drive-helpers";
import { extractAndLabel, mergePdfs } from "@/lib/pdf-processing";
import { getAuth } from "@/lib/ownership";
import { ownsProject } from "@/lib/ownership";
import type { AuthResult } from "@/lib/auth";

export const pdfExportInputSchema = z.object({
  problem_ids: z.array(z.string().uuid()).min(1).max(100),
});

type Env = { Variables: { authResult: AuthResult } };

/** concurrency-limited map (Drive API rate limit / Vercel メモリ保護) */
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const app = new Hono<Env>()
  /**
   * GET /health — in-process なので常に OK。
   * cf 版との client API 互換のため endpoint だけ残す。
   */
  .get("/health", (c) => c.json({ ok: true }))
  .post("/", zValidator("json", pdfExportInputSchema), async (c) => {
    const userId = getAuth(c).userId;
    const { problem_ids } = c.req.valid("json");

    // Drive token (= user-scoped、provider=google)
    const [tokens] = await db
      .select()
      .from(oauthToken)
      .where(and(eq(oauthToken.userId, userId), eq(oauthToken.provider, "google")))
      .limit(1);
    if (!tokens) return c.json({ error: "Google Drive not connected" }, 400);
    const accessToken = await getValidAccessToken({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.tokenExpiresAt,
    });

    // problems + ownership 同時確認 (JOIN で projectId → owner)
    const problems = await db
      .select()
      .from(problem)
      .where(inArray(problem.id, problem_ids));
    if (problems.length === 0) return c.json({ error: "No problems found" }, 404);

    // 全 problem が同じ user のプロジェクト配下か確認
    const projectIds = [...new Set(problems.map((p) => p.projectId))];
    for (const pid of projectIds) {
      if (!(await ownsProject(pid, userId))) {
        return c.json({ error: "Not authorized" }, 403);
      }
    }

    const files = await db
      .select()
      .from(problemFile)
      .where(inArray(problemFile.problemId, problem_ids));

    const subjectIds = [...new Set(problems.map((p) => p.subjectId).filter(Boolean))] as string[];
    const levelIds = [...new Set(problems.map((p) => p.levelId).filter(Boolean))] as string[];
    const subjectMap = new Map(
      subjectIds.length
        ? (await db.select().from(subject).where(inArray(subject.id, subjectIds))).map((s) => [s.id, s.name])
        : [],
    );
    const levelMap = new Map(
      levelIds.length
        ? (await db.select().from(level).where(inArray(level.id, levelIds))).map((l) => [l.id, l.name])
        : [],
    );

    problems.sort((a, b) => a.code.localeCompare(b.code));

    const work = problems.flatMap((p) => {
      const pf = files.find((f) => f.problemId === p.id);
      if (!pf) return [];
      const pages = (pf.problemPages as number[]) ?? [];
      if (pages.length === 0) return [];
      const subName = (p.subjectId && subjectMap.get(p.subjectId)) || "";
      const lvlName = (p.levelId && levelMap.get(p.levelId)) || "";
      return [{ pf, label: `${subName}_${lvlName}_${p.code}`, pages }];
    });
    if (work.length === 0) {
      return c.json({ error: "No problem pages found" }, 404);
    }

    // Drive download + per-file extract+label。並列度は Drive rate limit を考慮。
    const parts = await pMap(work, async (w) => {
      const raw = await downloadDriveFile(accessToken, w.pf.gdriveFileId);
      return extractAndLabel(new Uint8Array(raw), w.pages, w.label);
    }, 5);

    // mergePdfs は ArrayBuffer[] を取るので Uint8Array → ArrayBuffer に変換
    const merged = await mergePdfs(
      parts.map((u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer),
    );
    const today = new Date().toISOString().slice(0, 10);
    return new Response(Buffer.from(merged), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="exported-${today}.pdf"`,
      },
    });
  });

export default app;
