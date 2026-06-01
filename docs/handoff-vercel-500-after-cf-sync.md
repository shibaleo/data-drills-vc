# 申し送り: Vercel 全 API 500 / Clerk ログイン詰まり

別セッション再開用。`dfe7a84` (revert commit) 時点。

---

## 現在の状態

- HEAD: `dfe7a84` — "Revert server-side cf sync: db/index.ts + problems-list.ts cause 500s on vercel"
- Vercel 上で **ログインまでは到達**、ただし続く API 呼び出しの一部で `DrizzleQueryError` (500) が継続観測されている (`/api/v1/me`, `/api/v1/filter-prefs`, `/api/v1/backlog/today-count`, `/api/v1/review-scopes`, `/api/v1/projects/.../...` 等)

## 経緯

1. data-drills-cf から選択的に sync (`53acdcd`)。対象 7 ファイル:
   - React 系 (安全): `chart-shell.tsx`, `use-filter-prefs.ts`, 3 つの page.tsx, `backlog-chart.tsx`
   - Server 系 (今回問題): `src/lib/db/index.ts`, `src/routes/problems-list.ts`
   - `src/routes/backlog.ts` の JST fix も含む (これは無害)
2. Push 直後、全 API endpoint が 500 → Clerk ログインが「ログイン後に re-prompt」される動作に
3. Server 2 ファイルを revert (`dfe7a84`)。再デプロイ後ログインは戻ったが、500 が完全には消えてない (一部 endpoint で DrizzleQueryError 継続)

## ログから判明したこと

エラー本体は drizzle が postgres-js に流したクエリ:

```
DrizzleQueryError: Failed query: select "id", "name", "email" from "user" ...
```

= [src/lib/auth.ts](src/lib/auth.ts) の `findUser()` が落ちている。

→ 各 request の authenticate middleware で DB lookup 失敗 = 当然どの endpoint も 500。

## 仮説 (要検証)

1. **Supabase pgbouncer の prepared statement cache 不整合**
   - 症状的に最有力。postgres-js は default で prepared statement を使うが、Supabase pgbouncer (transaction pool mode) は connection 跨ぎで prepared statement を保持しない
   - 修正: [src/lib/db/index.ts](src/lib/db/index.ts) の `postgres(env.DATABASE_URL, { ... })` に `prepare: false` を追加
   - cf 側は `c7cab15` で同じ修正済 (cf は Hyperdrive 経由だが同じ理由)
2. **コネクション枯渇 (max=3 + 同時並列リクエスト)**
   - max=3 のままだと初期画面でのリクエスト洪水で枯渇する可能性
   - 修正: max を 5〜10 に上げる (Supabase pool_size: 15 の範囲内)
3. **DATABASE_URL の指す pooler エンドポイントが変わった**
   - Supabase の pooler URL の prefix (transaction vs session mode) を確認
   - session mode に切れば prepared statement 問題は出ない (が同時接続数は max=10 程度)

## 次セッションでの作業

### Step 1: エラー全文を取得

Vercel Dashboard → Deployments → `dfe7a84` deploy → Functions → `api/index` → Logs。
`DrizzleQueryError` 行をクリック展開し、postgres 側のエラーメッセージ (truncate されてない部分) を確認。

期待される文字列で原因確定:
- `prepared statement "s_N" does not exist` → 仮説 1
- `connection terminated unexpectedly` / `remaining connection slots are reserved` → 仮説 2
- `password authentication failed` / `does not exist` → 仮説 3 か env 設定

### Step 2: 仮説に応じた修正

仮説 1 の場合 (有力):
```ts
// src/lib/db/index.ts
globalForPg.__pgFallbackClient = postgres(env.DATABASE_URL, {
  max: 3,
  idle_timeout: 5,
  max_lifetime: 60,
  connect_timeout: 10,
  ssl: "require",
  prepare: false,   // ← 追加
});
```

### Step 3: cf からの再 sync を慎重に

revert 済の `src/routes/problems-list.ts` (inner JOIN + 入れ子 subquery)、`src/lib/db/index.ts` (process Symbol cache) を再投入するかは Step 1 の結果次第:

- prepared statement 問題が確定したら、`prepare: false` 入れた上で problems-list.ts の並列化を再投入 (パフォーマンス改善)
- 一方 process Symbol cache は vc では `withRequestDb` 使ってない (ALS の store path に入らない) ので意味薄い。skip 推奨

## ローカルでの確認結果 (前セッション)

- `npx tsc --noEmit` clean
- `pnpm build` (vite + esbuild api bundle) clean
- `node --input-type=module -e "import('./api/_bundle.mjs')..."` で bundle load OK
- 認証なしリクエストで handler invoke → 401 正常返却

→ 静的検証ではコードは正しい。**Vercel ランタイム上で DB 接続の何かが壊れている**。

## 保持されている cf sync (React-only、これは生きてる)

- `src/components/chart-shell.tsx` — hide-until-init + cursor offscreen 復帰
- `src/hooks/queries/use-filter-prefs.ts` — onSuccess で setQueryData (redundant GET 抑制)
- `src/app/(pages)/{review,throughput,backlog}/*/page.tsx` — lastSavedPrefsRef snapshot guard
- `src/components/backlog-chart.tsx` — milestone 縦線ドラッグ
- `src/routes/backlog.ts` — `fetchFirstAnswers` の no-asOf 枝に `AT TIME ZONE 'Asia/Tokyo'` 追加 (cursor 1日ズレ修正)

## 参考: cf 側の対応する commit

- `c7cab15` "db: add Hyperdrive-recommended postgres.js options to fix transient drops" — `fetch_types: false, prepare: false`。**この `prepare: false` 部分は vc にも適用すべき可能性高い**
- `a960aa3` "db: auto-retry GETs once on transient 'Network connection lost'" — CF entry 層、vc 適用不要
- `023cb28` "perf: parallelize DB queries in problems-list, raise pool to 5" — vc に再投入は Step 1 後
- `c67fcf9` "db: cache local-dev pg client on process Symbol" — vc では効果薄、skip 推奨
