# 部署

平台在 Cloudflare 上是兩個 Worker 和一個 D1：

| 環境 | api Worker | web Worker | D1 | 測試房 |
| --- | --- | --- | --- | --- |
| 本機（`wrangler dev`、`vite dev`） | `wrangler.jsonc` 最上層 | 最上層 | 本機 `agent-casino` | 用 `--var` 決定 |
| staging | `agent-casino-api-staging` | `agent-casino-web-staging` | `agent-casino-staging` | `ALLOW_TEST_ROOMS=true` |

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

## 加一個環境（例如正式環境）

1. 兩個 `wrangler.jsonc` 各加一段 `env.<名字>`，照 staging 那段改名字、D1 和 vars；正式環境不設 `ALLOW_TEST_ROOMS`。
2. 在 `apps/api`、`apps/web` 和根目錄的 `package.json` 照 `deploy:staging`、`db:migrate:staging` 加對應的 script。
3. 照上面「第一次部署」做一次，e2e 用 `--target=<名字>`。

`deploy`（沒有環境的那個 script）部署的是最上層設定，它沒有 D1 的 `database_id`，不要用它部署。
