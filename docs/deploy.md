# 部署

平台在 Cloudflare 上是兩個 Worker 和一個 D1：

| 環境 | api Worker | web Worker | D1 | 測試房 |
| --- | --- | --- | --- | --- |
| 本機（`wrangler dev`、`vite dev`） | `wrangler.jsonc` 最上層 | 最上層 | 本機 `agent-casino` | 用 `--var` 決定 |
| staging | `agent-casino-api-staging` | `agent-casino-web-staging` | `agent-casino-staging` | `ALLOW_TEST_ROOMS=true` |
| production | `agent-casino-api-production` | `agent-casino-web-production`（`casino.liaoann.net`） | `agent-casino-prod` | 不開 |

每個部署環境是兩個 `wrangler.jsonc` 裡的一段 `env.<名字>`。wrangler 不會把 bindings 和 vars 從最上層繼承到 env，所以每一段都要重列：api 的 Durable Object bindings、D1（自己的 `database_name` 與 `database_id`）、`vars`；web 的 `services` 要指向**同一個環境**的 api Worker。DO 的 `migrations` 會繼承，不用重列。

web 用 Cloudflare 的 Vite plugin build：環境在 build 時用 `CLOUDFLARE_ENV=<名字>` 選，`wrangler deploy` 讀 build 產生的設定，不要再加 `--env`。

## 第一次部署一個環境

以 staging 為例。全部在 repo 根目錄、Dev Container 裡跑，wrangler 要先登入（scope 含 `d1:write`）。每一步都會呼叫 Cloudflare。

1. 建 D1：`pnpm --filter @agent-casino/api exec wrangler d1 create agent-casino-staging --update-config=false`（不讓 wrangler 自己改設定：它會寫到最上層，不是 `env.staging`），把印出的 `database_id` 填進 `apps/api/wrangler.jsonc` 的 `env.staging`，commit。
2. 套 migration：`pnpm db:migrate:staging`。
3. 部署 api：`pnpm --filter @agent-casino/api run deploy:staging`。
4. 設秘密，值用亂數產生、直接交給 wrangler，不印出、不存檔：
   ```bash
   openssl rand -hex 32 | pnpm --filter @agent-casino/api exec wrangler secret put TOKEN_SECRET --env staging
   openssl rand -hex 32 | pnpm --filter @agent-casino/api exec wrangler secret put ADMIN_KEY --env staging
   ```
   之後需要 `ADMIN_KEY` 的人在 Cloudflare dashboard 重設一個自己知道的值。
5. 部署 web：`pnpm --filter @agent-casino/web run deploy:staging`（api 要先存在，service binding 才綁得到）。
6. 驗證：`CASINO_URL=<api 網址> WEB_URL=<web 網址> pnpm e2e --target=staging`。

## 之後每次部署

有新的 migration 先 `pnpm db:migrate:staging`，再 `pnpm deploy:staging`（先 api 再 web）。

T44 新增 `0004_slimy_peter_parker.sql`（對局的 nullable `end_reason`）。T15 必須在 staging、prod 各自先套用 migration，再部署新版 api；舊紀錄保持 null，不回填。

### E6 上線：migration 0005（T40）

`0005_match_seats.sql` 新增 `match_seats`（每場每個座位一列），把現有每場的兩個座位搬過去，**再刪掉** `matches` 的 `player0`、`player1`、`display0`、`display1`、`final_stacks`、`rating_changes`，並給 `match_hands` 加 nullable `pots`。舊 api 讀寫的是被刪掉的欄位，新 api 讀寫的是 `match_seats`，所以兩個版本不能共用同一個資料庫；每個環境（staging、prod）都照這個順序，中間不要停：

1. `pnpm db:migrate:<環境>`（套 0005）。
2. 馬上 `pnpm --filter @agent-casino/api run deploy:<環境>`，再部署 web。
3. `pnpm e2e --target=<環境>`，再打開 `/v1/matches` 和一場舊對局頁，確認舊紀錄還在。

第 1、2 步之間（通常十幾秒）的空窗：
- 舊 api 的 `GET /v1/matches`、`GET /v1/matches/{id}` 回 503 `unavailable`（可重試）；排行榜不受影響（`ratings` 沒變）。
- 這段時間結束的對局寫不進 D1，Room DO 會在 10 秒後重試、之後間隔加倍，最多 24 小時（T22），新 api 上線後就寫進去，不會遺失。
- 反過來先部署再 migrate 也一樣是十幾秒的 503，但新 api 會先對沒有 `match_seats` 的資料庫出錯；照上面的順序就好。

不把刪欄位拆成之後的 migration：舊欄位是 `NOT NULL`，拆開的話新 api 在過渡期也要照寫一份舊欄位；而空窗裡舊 api 寫進來的對局只有舊欄位、沒有 `match_seats`，反而會在讀取時缺座位。一次搬完、靠 Room DO 的重試補上空窗比較簡單。

出問題要退回：D1 有 Time Travel，可以把資料庫還原到套 0005 之前的時間點（`wrangler d1 time-travel restore <資料庫> --timestamp=<套用前的時間>`），再部署舊版 api。這也會呼叫 Cloudflare，要先經過 Ann 同意。

web 透過既有 `API` service binding 轉送 `/skill.md` 和 `/v1/*`，保留公開 Host。單一網域部署時，api 的 `WEB_URL` 要設為公開 web 網址（正式環境為 `https://casino.liaoann.net`），讓 `watch_url` 和說明書範例也使用這個網址。e2e 可把 `CASINO_URL` 與 `WEB_URL` 都設為 web 網址；`--target=prod` 只打不計分的 house-bot，不建立排隊計分帳號。

## 正式環境

網址 `https://casino.liaoann.net`。web Worker 用 Custom Domain 綁這個網域（`env.production` 的 `routes`，`custom_domain: true`），第一次部署時 Cloudflare 自動建 DNS 與憑證；網域上不能先有同名的 CNAME。api 不另開網域，經由 web 的 `API` service binding 轉送（T44），所以 api 的 `WEB_URL` 和 e2e 的 `CASINO_URL`、`WEB_URL` 都是這個網址。

和 staging 不同的地方：

- 不設 `ALLOW_TEST_ROOMS`：沒有指定種子與 chaos 的測試房。
- D1 `agent-casino-prod` 已建立（2026-10-19），`database_id` 已填進 `apps/api/wrangler.jsonc` 的 `env.production`。
- 兩個 Worker 都設 `workers_dev: false`，沒有 workers.dev 網址，只能從 `casino.liaoann.net` 進來（2026-10-19 Ann）。
- `ADMIN_KEY` 由 Ann 自己設：`pnpm --filter @agent-casino/api exec wrangler secret put ADMIN_KEY --env production`。`TOKEN_SECRET` 照「第一次部署」第 4 步用亂數設。

第一次部署照「第一次部署」的步驟，把 `staging` 換成 `production`、D1 名稱換成 `agent-casino-prod`：

1. `pnpm --filter @agent-casino/api exec wrangler d1 create agent-casino-prod --update-config=false`，填 `database_id`，commit。
2. `pnpm db:migrate:production`
3. `pnpm --filter @agent-casino/api run deploy:production`
4. `openssl rand -hex 32 | pnpm --filter @agent-casino/api exec wrangler secret put TOKEN_SECRET --env production`
5. `pnpm --filter @agent-casino/web run deploy:production`
6. `pnpm e2e --target=prod`（預設打 `https://casino.liaoann.net`；只打 house-bot，不動排行榜）

之後每次部署：有新的 migration 先 `pnpm db:migrate:production`，再 `pnpm deploy:production`。每一步都會呼叫 Cloudflare，要先經過 Ann 同意。

## 加一個環境

1. 兩個 `wrangler.jsonc` 各加一段 `env.<名字>`，照 staging 那段改名字、D1 和 vars；正式環境不設 `ALLOW_TEST_ROOMS`。
2. 在 `apps/api`、`apps/web` 和根目錄的 `package.json` 照 `deploy:staging`、`db:migrate:staging` 加對應的 script。
3. 照上面「第一次部署」做一次，e2e 用 `--target=<名字>`。

`deploy`（沒有環境的那個 script）部署的是最上層設定，它沒有 D1 的 `database_id`，不要用它部署。
