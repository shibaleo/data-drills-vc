# data-drills-vc Migration Plan

CF Worker + Render → Vercel への移設プラン。UI は data-drills-cf を継承し、API は data-drills (旧 Vercel 版) の構造をベースにリファクタする。

## 1. ゴール

1. **配信先**: Vercel 1 つに統一 (現状 CF Pages + CF Worker + Render Docker の 3 箇所)
2. **Cold start を Render free 由来の 30〜60s から Vercel Functions の <500ms に短縮**して安定化
3. **UI / UX は data-drills-cf に揃える** (TanStack Query, FSRS スライダー, About ページの新ドキュメント, etc.)
4. **コードはリファクタしてリポジトリ全体を整理する** (旧 data-drills の重複・古い API 呼び出しは引き継がない)

### 非ゴール (移設の範囲外)

- **API エンドポイントの追加・削除・契約変更は行わない**。data-drills-cf の現行 API 表面 (パス、メソッド、リクエスト/レスポンス形) を 1:1 で維持する。理由: 外部クライアント (Python tool taxtant、ブラウザ既存セッション) との互換性を保ちたい / cutover を URL 差し替えだけにしたい / リファクタを混ぜると問題切り分けが困難になる
- 認証の見直し / DB schema 変更 / 機能追加もすべて移設範囲外

## 2. ソースマッピング

| 領域 | 採用元 | 備考 |
|---|---|---|
| **Frontend pages** (`src/app/(pages)/`) | data-drills-cf | About / Schedule (slider) / Problems / etc. の最新版 |
| **Frontend components / hooks** | data-drills-cf | `hooks/queries/`, `hooks/use-project.tsx`, `components/shared/` 等 |
| **Server-state management** | data-drills-cf | TanStack Query (`src/hooks/queries/`, `src/lib/query-client.ts`) |
| **API client (RPC)** | data-drills-cf | `src/lib/rpc-client.ts` ＋ `import type { AppType }` |
| **Zod schemas** | data-drills-cf | `src/lib/schemas/` (フロント/バックで共有) |
| **Hono routes** | data-drills-cf | 21 routes (auth, projects, problems, schedule, statuses, etc.) |
| **DB schema** | data-drills-cf | `src/lib/db/schema.ts` |
| **Vercel Function entry** | data-drills (旧) | `src/server-entry.ts` (`hono/vercel` の `handle(app)`) |
| **API ビルド方式** | data-drills (旧) | `scripts/build-api.mjs` (esbuild で `api/_bundle.mjs` 出力) |
| **vercel.json** | data-drills (旧) | SPA rewrite |
| **PDF export ルート** | data-drills-cf の `services/pdf/src/routes/pdf-sync.ts` | Drive download + extract + merge ロジックを Vercel Function 内に持ってくる |
| **PDF service (Render)** | **廃止** | `services/pdf/` ディレクトリは持ち込まない |
| **CF Worker entry** | **廃止** | `src/cf-worker-entry.ts`, `wrangler.toml` は持ち込まない |
| **PDF scan/apply** | **既に外部化済み** | Python tool (`G:\マイドライブ\root\taxtant`) はそのまま、API key で叩く |

## 3. アーキテクチャ決定

### 3.1 Vercel Functions のプラン選択

| プラン | 月額 | Function 実行時間 | Function サイズ (uncompressed) | 判断 |
|---|---|---|---|---|
| Hobby | $0 | **10s** | 250MB | 10s は Drive download + merge が遅い時に超える可能性 |
| Pro | $20 | 60s | 250MB | 安全圏 |

判断軸は **実行時間** のみ。Bundle サイズ 250MB は両プラン共通なので懸念ではない (削減はあくまで cold start 速度のため)。

**初期方針**: Hobby で deploy → 実測。タイムアウト多発なら Pro へ昇格。Render free $0 → Vercel Hobby $0 の置換が成立すればそのまま。

### 3.2 PDF 処理の配置

旧 data-drills では `pdf-sync` ルートに scan/apply/export 全部入りだった。新 data-drills-vc では **export のみ** をメイン API ルート (`/api/v1/pdf-export`) として実装する。scan/apply は外部 Python tool 側で完結している。

**API 表面はすべて data-drills-cf と 1:1 維持**。エンドポイントの追加・削除・パス変更・契約変更は移設の範囲外とする。これにより外部クライアント (Python tool, ブラウザ) の挙動は URL の差し替えだけで済む。

ルート (data-drills-cf 互換):
- `POST /api/v1/pdf-export` — Body: `{ problem_ids: string[] }`、PDF を `application/pdf` で返却
  - 処理: Drive から PDF 取得 → 該当ページ抽出 + ラベル → 結合
  - 実装元: `data-drills-cf/services/pdf/src/routes/pdf-sync.ts` の `/export` ハンドラを inline 化
- `GET /api/v1/pdf-export/health` — 維持。Vercel では cold start が極小だが、エンドポイントの存在自体は残す (クライアントの `exportPhase = "waking"` 段階を呼び出し可能に保つ)。実装は単に `c.json({ ok: true })` を返すだけで十分

### 3.3 認証

data-drills-cf と同じ:
- ブラウザ: Clerk (フロント) + Hono の `authenticate` ミドルウェア (バック)
- 外部 (Python tool): `Authorization: Bearer dd_xxx` の API key 認証

`src/lib/auth.ts` の API key in-memory cache (5分 TTL) もそのまま継承。

### 3.4 DB 接続

Vercel Functions は Node.js runtime で TCP socket が普通に開くので、CF の Hyperdrive 相当の中継は不要。Supabase に直接 TCP 接続する。

接続オプション:
- **Session Pooler** (port 5432, supavisor session mode) — 推奨。prepared statements 使える、connection multiplexing で同時 invocation を捌ける
- **Direct connection** (port 5432, バイパス) — 同時実行が小さければ問題なし
- ~~Transaction Pooler (port 6543)~~ — `prepare: false` 必須で drizzle 周辺の動作確認が増える、避ける

`src/lib/db/index.ts` は Vercel 用に簡略化:
- AsyncLocalStorage の per-request client は不要
- module スコープで `postgres()` を 1 つ作って Function 再利用 (warm 時は connection 再利用)
- `DATABASE_URL` は Session Pooler URL

### 3.5 環境変数

Vercel ダッシュボードまたは `vercel env` で以下を設定:
- `DATABASE_URL` (Supabase pooler)
- `CLERK_SECRET_KEY` / `VITE_CLERK_PUBLISHABLE_KEY`
- `JWT_SECRET`
- `ADMIN_API_KEY`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `BASE_URL` (Vercel URL に合わせて設定; OAuth callback で使用)
- ~~`PDF_API_URL` / `PDF_SERVICE_KEY`~~ (Render 廃止により不要)

### 3.6 OAuth リダイレクト

- Clerk の Allowed Origins に Vercel URL を追加
- Google OAuth Console で `redirect_uri` に Vercel URL の callback を追加

## 4. ディレクトリ構造 (target)

```
data-drills-vc/
├── api/
│   ├── _bundle.mjs          (esbuild 出力、git-ignored)
│   └── index.ts             (re-export from _bundle)
├── src/
│   ├── app/
│   │   └── (pages)/         (data-drills-cf からそのままコピー)
│   ├── components/          (data-drills-cf から)
│   ├── hooks/
│   │   ├── queries/         (data-drills-cf の TanStack Query フック)
│   │   ├── use-project.tsx
│   │   └── ...
│   ├── lib/
│   │   ├── db/
│   │   │   ├── index.ts     (Vercel 用に簡略化)
│   │   │   └── schema.ts    (data-drills-cf から)
│   │   ├── schemas/         (data-drills-cf から)
│   │   ├── auth.ts
│   │   ├── hono-app.ts      (data-drills-cf から、pdf-export ルートを差し替え)
│   │   ├── rpc-client.ts
│   │   ├── query-client.ts
│   │   ├── pdf-processing.ts (services/pdf から移植)
│   │   ├── drive-helpers.ts
│   │   ├── google-oauth.ts
│   │   └── ...
│   ├── routes/
│   │   ├── pdf-export.ts    (新規: services/pdf/routes/pdf-sync.ts /export を inline 化)
│   │   └── ...              (他は data-drills-cf から)
│   ├── main.tsx
│   ├── router.tsx
│   └── server-entry.ts      (旧 data-drills から)
├── scripts/
│   ├── bootstrap.ts
│   └── build-api.mjs        (旧 data-drills から)
├── package.json             (data-drills-cf 由来 + pdf-lib + googleapis + jose 追加)
├── vercel.json              (旧 data-drills から)
├── vite.config.ts           (旧 data-drills から、Hono dev plugin は維持)
├── tsconfig.json
├── drizzle.config.ts
├── components.json          (shadcn/ui 設定)
├── postcss.config.mjs
├── README.md
└── .gitignore
```

## 5. フェーズ別実装手順

### Phase 0: 下準備 (30分)

- [ ] Supabase の Connection Pooler URL を取得 (port 6543, pgbouncer mode=transaction)
- [ ] Vercel に新規プロジェクト作成 (deploy はまだ; ローカルで build 確認するだけ)
- [ ] data-drills-vc の `.gitignore` を Vercel/Node 向けに整備 (`api/_bundle.mjs`, `dist/`, `node_modules/`, `.vercel/`)

### Phase 1: ベースを data-drills-cf からコピー (1時間)

- [ ] data-drills-cf の `src/`, `components.json`, `tsconfig.json`, `drizzle.config.ts`, `vite.config.ts`, `postcss.config.mjs`, `index.html`, `assets/` を data-drills-vc にコピー
- [ ] **除外**: `src/cf-worker-entry.ts`, `wrangler.toml`, `services/`, `scripts/build-worker.mjs` (もしあれば)
- [ ] `src/routes/pdf-export.ts` を空に (Phase 3 で書き直す)
- [ ] `src/lib/hono-app.ts` の `import pdfExport from "@/routes/pdf-export"` は残す (Phase 3 で実装)
- [ ] `package.json` を data-drills-cf から引いて、cf 専用 dep (`@cloudflare/workers-types`, `wrangler`) を削除、Vercel 用 dep (`@hono/vercel`) を追加、PDF 処理用 dep (`pdf-lib`, `@pdf-lib/fontkit`, `googleapis`, `pdfjs-dist` は client 用に必要なら) を追加
- [ ] `pnpm install`

### Phase 2: Vercel Function entry + ビルド経路 (30分)

- [ ] 旧 data-drills から以下をコピー:
  - `src/server-entry.ts`
  - `scripts/build-api.mjs`
  - `vercel.json`
  - `api/index.ts` (re-export)
- [ ] `package.json` の `scripts.build` を `vite build && node scripts/build-api.mjs` に変更
- [ ] ローカルで `pnpm build` が通ることを確認 (まだ pdf-export は空なので OK)

### Phase 3: PDF export ルート移植 (1.5時間)

- [ ] **`google-oauth.ts` を `googleapis` ベースから raw `fetch` ベースに書き直す** (refreshAccessToken + downloadDriveFile の 2 関数のみ。§7.2 のサンプル参照)
- [ ] **`pdf-processing.ts` のフォントを Noto Sans JP Subset (Japanese) ~2MB に差し替え** (`assets/fonts/NotoSansJP-Regular.subset.ttf` で配置)
- [ ] data-drills-cf `services/pdf/src/lib/pdf-processing.ts` の処理本体を data-drills-vc `src/lib/pdf-processing.ts` に移動 (font path 修正)
- [ ] data-drills-cf `services/pdf/src/routes/pdf-sync.ts` の `/export` ハンドラを `src/routes/pdf-export.ts` の `POST /` として実装
  - DB は `@/lib/db` 経由 (services/pdf 専用の DB client は不要、メイン DB を使う)
  - 認証は Hono の親アプリの `authenticate` ミドルウェアでカバー済み
- [ ] `src/routes/pdf-export.ts` の `GET /health` を data-drills-cf 仕様のまま残す (中身は単純な OK 返答で OK、外部 Render に飛ばす実装は不要)
- [ ] **`package.json` から `googleapis` を削除**
- [ ] **クライアント側 (`src/app/(pages)/schedule/page.tsx` の `handleExport`) は触らない** — `/health` プローブ呼び出しと `exportPhase = "waking"` はそのまま。Vercel では `/health` が即時 OK を返すので「Render 起床中...」ラベルは一瞬光って消える挙動になる (UX 上問題なし)

### Phase 4: DB 接続を Vercel 用に修正 (15分)

- [ ] `src/lib/db/index.ts` を Vercel Function 環境向けに書き直し:
  - AsyncLocalStorage は不要 (短命 invocation なので per-request client = per-invocation client)
  - `postgres()` 1 つを module スコープで作る (Hot Function で再利用)
  - `DATABASE_URL` は Supabase pooler (pgbouncer transaction mode)
  - `prepare: false` を `postgres` オプションに渡す (pgbouncer 互換)

### Phase 5: 認証とミドルウェア整備 (30分)

- [ ] `src/lib/auth.ts` をそのまま使う (Clerk + JWT + API key)
- [ ] `src/lib/hono-app.ts` の auth middleware の流れは data-drills-cf と同一
- [ ] Vercel の `Edge Config` を使うかは要検討 (使わなくても通常 Function で動作する)

### Phase 6: ローカル検証 (1時間)

- [ ] `.env` に Supabase pooler URL + Clerk + Google + JWT_SECRET を入れる
- [ ] `pnpm dev` で Vite + Hono dev plugin で動作確認
- [ ] 主要画面: Login → Projects → Problems → Answers → Schedule → PDF export まで一通り
- [ ] FSRS スライダー、About ページ、stability_days 編集も確認

### Phase 7: Vercel deploy (preview) (30分)

- [ ] `vercel link`
- [ ] `vercel env` で env を Production / Preview に投入
- [ ] `vercel --prod=false` で preview deploy
- [ ] preview URL で同じ動作確認
- [ ] **PDF export を実機 (iPhone Safari, 別 PC) で繰り返しテスト**して安定性検証

### Phase 8: 本番 cutover (15分)

- [ ] CF Worker (`data-drills-cf.shibaleo.workers.dev`) と Vercel URL の **両方を平行運用**できる期間を作る
- [ ] Python tool (`taxtant/config.json`) の `drills_api_url` を Vercel URL に切り替えて動作確認 → 問題なければ commit
- [ ] Clerk Allowed Origins, Google OAuth Redirect URI を Vercel URL に揃える
- [ ] Production deploy: `vercel --prod`
- [ ] 1 週間程度様子見してから CF Worker と Render Docker を止める

## 6. リファクタ機会 (移設ついでに整理)

**前提**: §1 の非ゴール通り、API エンドポイントには手を入れない。ここで挙げるのは UI / 内部実装 / 依存パッケージの整理のみ。

旧 data-drills と data-drills-cf の差分から、移設時に整理しておきたい点:

- [ ] **`api-responses.ts` (旧 lib) は捨てる**: data-drills-cf では Zod schemas + RPC で型は取れるので不要 (実装側のみ、API 出力形は変えない)
- [ ] **`retention-series.ts` (旧 lib) は data-drills-cf に存在しない**: 削除済みなら持ち込まない、必要なら別途検討
- [ ] **`src/middleware/`** ディレクトリ (旧、空っぽ): 作らない
- [ ] **`stats` ページ (旧 UI)**: data-drills-cf にないので持ち込まない (フロントページのみ、API には触れない)
- [ ] **`pdf-sync` ページ (旧 UI)**: 同上、持ち込まない (Python tool がカバー、API には触れない)
- [ ] **`scripts/check-*` / `migrate-*` 系 (旧 30 個近く)**: マイグレーション完了済みなので捨てる
- [ ] **`bcryptjs` 依存**: API key hash に使われ続けるので**残す**
- [ ] **`react-pdf`, `pdfjs-dist` (旧)**: フロントで PDF プレビューしてないなら削除 (フロント依存のみ)

## 7. リスクと未確定事項

### 7.1 Vercel Hobby の 10s 実行時間制限

`pdf-export` の Drive download + merge は実測 5〜15s。問題数が多い時は超える可能性あり。
- **判定基準**: Phase 7 で 20 問選択 export を 5 回連続実行し、1 度でも timeout が出たら Pro へ昇格
- **回避策候補**: streaming response (要検証) / 並列度を上げる / 問題数の上限 UI 制限

### 7.2 Bundle 削減 (cold start 高速化のため、必須ではない)

bundle サイズ自体は 250MB まで OK だが、cold start 時間は bundle サイズに比例するので削減価値あり。**主な肥大要因 2 つ**:

#### googleapis + google-auth-library (~15MB) → 0 へ削除

実際の使用は **OAuth refresh + Drive ファイル 1 個ダウンロード** のみ。raw `fetch` で書き直せる:

```ts
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return (await res.json()).access_token;
}

async function downloadDriveFile(accessToken: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.arrayBuffer();
}
```

合計 ~30 LOC、依存ゼロ。Phase 3 でこの形で書く。

#### yumin.ttf (13MB) → 2MB 程度のサブセットへ

ラベルは `${subjectName}_${levelName}_${problemCode}` のみ。フルセットの日本語フォントは不要。

選択肢:
1. **Noto Sans JP Subset (Japanese)** ~2MB を `assets/fonts/` にコミット (推奨、初期実装)
2. **ビルド時に DB から実ラベル文字を抽出して dynamic subset** ~100KB (`subset-font` パッケージ、build hook で実行)

初期は (1) で動かす → 気になれば (2) に進化。

#### その他

- `pdfjs-dist`, `react-pdf` はクライアント専用、API bundle に入らない (`server-entry.ts` から到達しない経路) ことを Vercel NFT で確認
- `bcryptjs` (旧 data-drills 由来): Clerk 主体なら削除

#### 削減見込み

| 項目 | 旧 | 新 | 削減 |
|---|---|---|---|
| googleapis + google-auth-library | ~15MB | 0 | -15MB |
| yumin.ttf | 13MB | 2MB | -11MB |
| 合計 | ~28MB | ~2MB | **~26MB** |

### 7.3 Supabase Connection Pooler の選択

- **Session Pooler (port 5432)** を採用すれば prepared statement そのまま動く (drizzle 既定設定)
- Transaction Pooler (port 6543) を選ぶ場合は `postgres({ prepare: false })` 必須
- 直接接続 (バイパス) も Vercel Functions の同時実行が小さければ機能する

### 7.4 Clerk のセッション

Clerk は CF と Vercel どちらでも動くが、設定を新環境で再投入が必要。Allowed Origins に新ドメイン追加するだけで済むはず。

### 7.5 Google Drive OAuth トークン保存

DB に保存しているのでドメインを変えても継承される。ただし新環境からアクセスする際の `redirect_uri` 整合性に注意。

## 8. 完了の定義

- [ ] data-drills-vc を Vercel に deploy 済みで、本番 URL から data-drills-cf と同じ操作が全部できる
- [ ] PDF export が iPhone / Windows / Mac から各 5 回連続で安定動作 (cold start 30s 待たされない)
- [ ] Python tool (taxtant) が新 URL に対して sync できる
- [ ] 旧 CF Worker と Render Docker をシャットダウンできる
- [ ] data-drills-vc の README に開発・deploy 手順がまとまっている
- [ ] data-drills (旧 Vercel 版) と data-drills-cf は読み取り専用 archive にできる
