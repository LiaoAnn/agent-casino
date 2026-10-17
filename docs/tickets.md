# Agent Casino：Epic 與 Ticket

要做的事都寫在這份。Epic 是目標，Ticket 是一次的工作範圍；規格不寫在這裡，而是指向 skill。不開 GitHub issue。

一張 ticket 算完成 = 它的 PR（branch `t<編號>-<簡短英文>`）已合併進 `main`。每張 ticket 現在的狀態跑 `scripts/board.sh` 看（從依賴、branch、PR 推算，不手動維護）。一張 ticket 怎麼做到合併見 `ticket-workflow` skill，怎麼派工見 `coordinator` skill。

## 各自的身份

| 東西 | 放哪 | 負責什麼 | 不放什麼 |
| --- | --- | --- | --- |
| `AGENTS.md` | repo 根目錄，每次都載入 | 一頁地圖：專案是什麼、結構、指令、不能違反的規則、知識在哪 | 規格細節、ticket、環境設定 |
| Skill | repo 的 `.claude/skills/`，需要時才載入 | 長期不變的領域知識與做法：規則、API 規格、怎麼做 ticket、怎麼試玩 | 這次要做哪件事 |
| Epic | 這份檔案 | 一個可交付成果的目標和完成定義，底下掛 ticket | 實作細節 |
| Ticket | 這份檔案（Epic 底下） | 一次工作的範圍、依賴、只改哪些資料夾、驗證指令、功能驗證 | 規格本身（指向 skill） |
| PR template | `.github/pull_request_template.md` | 交付時要附的證據格式 | |
| Dev VM 的 CLAUDE.md | Ann 的機器上 | worktree、compose、網址等環境知識 | 專案知識 |

## 標記
- 🔒 `needs-human`：要人核准才能合併的 ticket。PR 加上這個標籤。只留給正式部署這種非人不可的事，其他都交給 agent。
- ★ `playtest`：要找 3 個全新 agent 試玩的 ticket（照 `agent-playtest` skill）。

## 排程參考：分波（同一波可同時派給不同 agent）

| 波 | Ticket（可同時做） | 需要幾個 agent |
| --- | --- | --- |
| 1 | T01 | 1 |
| 2 | T02、T03 | 2 |
| 3 | T04、T06、T17 | 3 |
| 3.5 | T05、T07 | 2 |
| 4 | T08、T09、T10 | 3 |
| 5 | T11、T12 | 2 |
| 6 | T13 | 1 |
| 7 | T14 ★ | 1 + 3 個試玩 agent |
| 8 | T15 ★🔒 | 1 + 3 個試玩 agent |

最長的一條路是 T01 → T02 → T04 → T09 → T11 → T13 → T14 → T15，共 8 步；其他 ticket 都在旁邊同時進行。

## Epic E0 地基

**完成定義**：任何 agent clone 下來，`pnpm check` 一個指令就知道過不過。

### T01 Monorepo 骨架（約 500 行）· Blocked by：無
- pnpm workspace（`apps/api`、`apps/web`）、TS strict、Biome、knip、Vitest、GitHub Actions、`pnpm check`、CI 擋 `.skip` / `.only`。保留 repo 裡已有的 AGENTS.md、`.claude/skills/`、`docs/`、`.github/` 檔案。
- `apps/api` 是一個 Worker，有 `GET /health` 回 `{"ok":true}`，wrangler 設定好 DO 與 D1 綁定。
- 只改：根目錄設定、`.github/`、`apps/*` 的骨架。
- 驗證：`pnpm check` 全過。功能驗證：啟動 api 後 `curl /health` 回 ok。

### T16 拿掉範本的本機 cron 排程器（約 300 行，大多是刪除）· Blocked by：T01
- 平台不用 cron（超時代打用 Room DO 的 alarm），範本附的本機 cron 排程器用不到，還有雙堆疊環境的 bug（`dev-servers.mjs` 的 `wranglerOrigin()` 把 `127.0.0.1` 和 `::1` 當成兩台伺服器）。整個拿掉，需要時再從 git 歷史找回來。
- 拿掉：`.devcontainer/devcontainer.json` 的 `postStartCommand`、`.devcontainer/scripts/` 的 `cron.*` 與 `dev-servers.*`、`.devcontainer/cron-targets.jsonc`（如果有）、根目錄 `package.json` 的 `dev:cron`、`test:cron` 和只為它們存在的依賴、`knip.jsonc` 裡相關的設定、README 的「Local cron triggers」段與指令表裡的兩列。
- 只改：上面列的檔案。`post-create.sh` 和其他 devcontainer 設定不動。
- 驗證：`pnpm check` 全過（knip 不再報出多的依賴或檔案）。
- 功能驗證：`wt-up` 重建後容器正常起來，`/health` 回 `{"ok":true}`，容器裡沒有 cron 程序在跑。

## Epic E1 德州規則（`apps/api/src/holdem`，純函式）

**完成定義**：不碰網路就能用「種子 + 動作」打完並重播任何一場，1 萬手 fuzz 0 違規。

### T02 牌與比牌（約 700 行）· Blocked by：T01
- 牌的表示、mulberry32 與洗牌（holdem-rules skill）、7 選 5 比牌。
- 只改：`apps/api/src/holdem/`。
- 驗證：`pnpm test holdem`。對照牌型標準答案全對；同種子洗兩次一模一樣。

### T04 一手牌流程（約 1000 行）· Blocked by：T02
- holdem-rules skill 全部：盲注、行動順序、合法動作、最小加注、不足額全下、退回多出的下注、攤牌分池、換莊、整場結束、每個座位的 `view`、`last_hand`。
- 介面只做四件事：開局、列出合法動作、執行動作、給某座位看它的局面。
- 只改：`apps/api/src/holdem/`。
- 驗證：`pnpm test holdem`，至少 30 個「種子 + 動作 → 預期結果」案例。

### T08 亂打機器人與重播（約 500 行）· Blocked by：T04
- 亂打機器人、不變量檢查、`replay(seed, events)`、終端機小工具 `pnpm holdem:play`。
- 只改：`apps/api/src/holdem/`、`apps/api/scripts/`。
- 驗證：`pnpm test:fuzz`（1 萬手 0 違規）。功能驗證：用 `pnpm holdem:play` 跟機器人打 3 手，貼過程。

### T20 換成密碼學洗牌（約 500 行）· Blocked by：T09、T19
- 照 holdem-rules skill 新的「種子與洗牌」：256 位元祕密種子（64 個十六進位字元）、HMAC-SHA256 亂數流、不偏的 Fisher–Yates。取代 T02 的 32 位元種子 + mulberry32，因為舊的可以在一場比賽內被暴力猜出來（T09 的 security review 發現）。
- 要改的地方：
  - `holdem/`：洗牌與種子型別、`startMatch` / `replay` 的設定、T02 的標準答案測試換成新規格的標準答案（這是規格變更，不算削弱測試；舊的黃金值測試要換掉，不是刪掉不補），加上 RFC 4231 的 HMAC 測試向量。fuzz 照常 1 萬手 0 違規。
  - `contract/`：`seed`（對局紀錄與 `test.seed`）從 `Uint32` 改成 64 個小寫十六進位字元的字串；假資料照新規格產生。這是合約變更。
  - `room/`：開房時產生種子的那一處改用密碼學亂數；確認比賽進行中任何回應都不含種子。
  - `db/`：如果 T07 的 `matches.seed` 不是字串欄位，加一個 migration 改掉。
  - HMAC-SHA256 要同步：可以用經過審計的小套件（例如 `@noble/hashes`），或在 Node、workerd、網頁 server function 都可用的同步實作；在 /plan-it 決定並寫明取捨，不加多餘的依賴。
- 只改：上面列的 `holdem/`、`contract/`、`room/` 裡產生種子的地方、`db/`（只限 seed 欄位），以及 `apps/api/package.json` 新增依賴。
- 驗證：`pnpm check`（含新的標準答案與 HMAC 測試向量）、`pnpm test:fuzz`、`pnpm test:web`。
- 功能驗證：起 api dev server，用 curl 開一個 `test.seed` 指定的房間，確認發出的底牌跟標準答案一致；用另一個房間確認 `state`、`wait` 的回應裡找不到種子。

## Epic E2 合約與對局服務

**完成定義**：兩個只會 curl 的玩家能在測試環境排隊、打完一場、看到排行榜變動。

### T03 API 合約與房間 token（約 700 行）· Blocked by：T01
- 用 Effect HttpApi 定義 casino-api skill 的**所有**端點、請求、回應、錯誤（含 HTTP 狀態碼）；token 簽發與檢查；從合約產生假資料的工具（給 T06、T10 用）。
- 只改：`apps/api/src/contract/`、`apps/api/src/token/`。
- 驗證：`pnpm test contract`。功能驗證：偽造、過期、拿別房的 token 都被拒絕。
- reviewer 另外對照 casino-api skill 檢查端點與欄位命名、錯誤訊息的寫法；拿不定的設計問題問人。

### T17 把合約接上 Worker（約 400 行）· Blocked by：T03
- 讓 `apps/api` 的 Worker 用 T03 的 `CasinoApi` 回應所有端點，之後的 ticket 只要填自己那組 handler，不用再碰共用檔案。
- 內容：
  - `app.ts`、`index.ts` 改用 Effect HttpApi 提供服務，保留 `GET /health`。
  - 共用錯誤處理：Effect 的 schema decode 錯誤、找不到路由，都轉成 casino-api skill 的錯誤格式（`invalid_request` 400；不存在的路徑維持合約的定義或 404），不新增錯誤碼。
  - 實作 `RoomAuth`（用 `token/verifyRoomToken` 檢查簽名、過期、別房 token，失敗回 `invalid_token`）和 `AdminAuth`（比對 Worker secret `ADMIN_KEY`）。「房間結束 1 小時後拒絕」不在這裡，留給 T09 的 Room DO。
  - 每組 handler 放在自己的檔案，先是回固定錯誤的空殼（用合約已有的錯誤碼，例如 `internal` 加上「not implemented yet」的 message）：`routes/skill.ts`（T05）、`routes/read.ts` 和 `routes/admin.ts`（T07）、`routes/room.ts`（T09：房間端點和 lobby 的開房、進房）、`routes/queue.ts`（T12：lobby 的排隊）。lobby 這組橫跨 T09、T12，要讓兩張 ticket 各自只改自己的檔案。
  - `TOKEN_SECRET`、`ADMIN_KEY` 只從 Worker secret 讀；本機用 `.dev.vars`（gitignore）或測試用的假值，不把真的秘密寫進 repo。
- 只改：`apps/api/src/app.ts`、`apps/api/src/index.ts`、`apps/api/src/routes/`、`apps/api/src/auth/`（新的，放兩個 middleware），以及根目錄新增 `test:api` script。不改 `contract/`、`token/`。
- 驗證：`pnpm test:api`：每個端點都接得到（空殼回合約的錯誤格式）、壞的 JSON 回 `invalid_request`、偽造／過期／別房的 token 回 `invalid_token`、錯的管理員金鑰回 `invalid_token`、`/health` 照舊。
- 功能驗證：起 api dev server，用 curl 打 worktree 網址：`/health`、一個空殼端點、一個壞 JSON 的請求、一個沒帶 token 的房間端點，回應都符合合約的錯誤格式。

### T19 合約加上 not_found 錯誤碼（約 150 行）· Blocked by：T17
- 打到不存在的路徑、或 method 不對時，回 404 + 新錯誤碼 `not_found`（hint 指向 `/skill.md`），取代 T17 暫定的「404 + `invalid_request`」，讓每個錯誤碼都只對應一個 HTTP 狀態碼（casino-api skill A4，已更新）。
- 這是合約 ticket：可以改 `apps/api/src/contract/`（`ERROR_CODES`、`ERROR_STATUS`，以及任何列出全部錯誤碼的地方）和 `apps/api/src/app.ts` 的共用錯誤處理。不改各組 handler 的檔案（`routes/*.ts`）。
- 順便修假資料 `contract/fake.ts`（T10 發現）：一手結束的 `pot` 要照 holdem-rules「引擎的細節定案」，不含退回的未跟注下注（現在「加注到 6 後對手棄牌」寫成 8，應為 4；小盲直接棄牌寫成 3，應為 2）。並補上目前沒有的情境：翻牌後棄牌（有部分公共牌）、非棄牌的超時代打（例如過牌被代打）、全下。最好直接用 holdem 引擎（`startMatch`、`applyAction`）產生假資料的每一手，跟真的規則保持一致。
- 驗證：`pnpm test contract`、`pnpm test:api`：未知路徑、錯的 method 都回 404 + `not_found`，`ERROR_STATUS` 每個 code 的對應都成立，原本的錯誤回應不變。假資料的每一手都符合規則（可以用 holdem 引擎重算比對），上面三種情境都至少出現一次。
- 功能驗證：起 api dev server，curl 一個不存在的路徑和一個錯的 method，回應符合錯誤格式。

### T07 紀錄、積分與讀取端點（約 700 行）· Blocked by：T17
- Drizzle schema 與 drizzle-kit migrations（D1）、`recordMatch()`（給房間結束時呼叫）、Elo 計算、`leaderboard`、`matches`、管理員停權。
- 只改：`apps/api/src/db/`、`apps/api/src/routes/read.ts`、`apps/api/src/routes/admin.ts`。
- 驗證：`pnpm test:api`。功能驗證：直接呼叫 `recordMatch()` 寫入兩場，用 curl 看排行榜分數正確。

### T09 房間裁判（約 1000 行）· Blocked by：T04、T17
- Room DO（一房一個）：開房、邀請碼進房、`wait`（30 秒長輪詢）、`state`、`actions`（casino-api skill A3 的 `turn_id` 規則）、`leave`。
- 只改：`apps/api/src/room/`、`apps/api/src/routes/room.ts`。
- 驗證：`pnpm test:api`。功能驗證：開兩個終端機用 curl 自己跟自己打完 1 手。

### T11 超時與狀況處理（約 600 行）· Blocked by：T09
- DO alarm 超時代打、連 3 次離席、5 分鐘解散、非法 / 太晚 / 重複 / 離開、測試房的 `test.seed` 與 `test.chaos`（casino-api skill A11）、管理員中止房間（A9：這場標 `void`，不計分）。
- 只改：`apps/api/src/room/`，以及 `apps/api/src/routes/admin.ts` 裡的 `abortRoom` 這一個 handler（T07 留下的空殼）。
- 驗證：`pnpm test:api`，casino-api skill「狀況處理」表與 A11 每項一個測試。

### T12 配對排隊（約 600 行）· Blocked by：T07、T09
- Matchmaker DO、`POST /v1/queue`（casino-api skill A2）、由 Matchmaker 依序寫入 Elo（casino-api skill A10）。
- 只改：`apps/api/src/matchmaker/`、`apps/api/src/routes/queue.ts`。
- 驗證：`pnpm test:api`。同時排 2 人進同一房；只有 1 人時 30 秒回 `waiting`；同時結束兩場，Elo 不會互相覆蓋。

### T13 串起來與測試環境（約 800 行）· Blocked by：T05、T08、T10、T11、T12
- 房間結束 → 重播比對 → `recordMatch()`；內建機器人 `house-bot` 進房（casino-api skill A1）；網頁改接真 API；`scripts/e2e.sh`；skill.md 範例實打檢查；部署到 Cloudflare 測試環境。
- 驗證：`pnpm e2e --target=staging` 與 `pnpm test:skill` 全過。
- 功能驗證：在測試環境用 curl 跟 `house-bot` 打完一場 10 手，網頁上看得到這場。

## Epic E3 Skill 與接入

**完成定義**：全新的 Claude Code、Codex 只收到一句話就能自己打完一場，不問人。

### T05 skill.md（約 600 行）· Blocked by：T17
- casino-api skill 的 skill.md 段落與 A12：模板、從合約填入、`GET /skill.md`。範例實打檢查留到 T13。
- 只改：`apps/api/src/skill/`、`apps/api/src/routes/skill.ts`。
- 驗證：`pnpm test:skill`（產生的檔案包含每個端點、每個錯誤碼、frontmatter 格式正確）。
- 功能驗證：找一個全新 agent 只讀 skill.md，請它寫出打一局的 curl 步驟（還不用真打），對照合約全對。

### T14 真 agent 試玩與狀況演練 ★（約 600 行）· Blocked by：T13
- `pnpm playtest`：`claude -p` 與 `codex exec` 互打；chaos 測試房（casino-api skill A11 的環境預設）；照 agent-playtest skill 找三個 agent 試玩並寫報告；依報告修 skill.md 與錯誤訊息。
- 驗證：`pnpm playtest`。
- 功能驗證：agent-playtest skill 的「能用」全過。
- 試玩報告跟 PR 一起由 reviewer 對照 agent-playtest skill 的門檻檢查。

## Epic E4 觀看網頁

**完成定義**：人打開網頁就看得到排行榜和每場的逐步紀錄，網頁上沒有任何可操作的東西。

### T06 網頁骨架與排行榜（約 700 行）· Blocked by：T03
- TanStack Start 部署在 Workers、Tailwind、shadcn/ui、首頁排行榜與最近對局。先用合約產生的假資料。
- 只改：`apps/web/`。
- 驗證：`pnpm test:web`（Playwright 打開頁面，找到假資料裡的名字）。功能驗證：截圖貼在 PR。

### T10 對局紀錄頁（約 700 行）· Blocked by：T06
- `/matches/{match_id}`，每一步文字紀錄；先用假資料。
- 只改：`apps/web/`。
- 驗證：`pnpm test:web`。功能驗證：截圖貼在 PR。

### T18 CI 跑網頁測試（約 100 行）· Blocked by：T06
- `.github/workflows/ci.yml` 新增一個 job：`pnpm install --frozen-lockfile`、安裝跟 `@playwright/test` 同版的 Chromium（headless shell）、跑 `pnpm test:web`。原本的 `check` job 不動。
- 瀏覽器版本跟 `apps/web` 的 `@playwright/test` 綁在一起（從 lockfile 或 package 讀，不要另外寫死一個版本）；能快取瀏覽器就快取。
- 只改：`.github/workflows/ci.yml`（新增 job，不改別人寫的 job）。README 指令表裡 `pnpm test:web` 的說明「not in `pnpm check` or CI yet」改成在 CI 跑。
- 驗證：這張 PR 自己的 CI：新 job 綠燈。另外在一個不合併的暫時 commit 故意弄壞一個網頁測試，確認新 job 會紅，再拿掉。
- 功能驗證：PR 頁面上看得到兩個 job（check、web）都是綠的。

## Epic E5 上線

**完成定義**：正式環境可用，三個 agent 試玩通過。

### T15 正式上線 ★🔒（約 500 行）· Blocked by：T14
- 正式環境部署（人同意後）、管理員金鑰、試玩發現的小修正。
- 驗證：`pnpm e2e --target=prod`。
- 功能驗證：三個 agent 在正式環境各打一場 10 手局。
- 🔒 人看：試玩報告 + 同意部署。

## 還沒定、先照預設做的

| 問題 | 預設 |
| --- | --- |
| Cloudflare 帳號、測試與正式網域 | T13 前由人提供；之前全部在本機跑 |
| CI 要不要放 Claude Code / Codex 的登入憑證 | 先不放，`pnpm playtest` 由 agent 手動觸發 |
| casino-api skill 的細節數字（名字規則、Elo 參數、token 有效期、排隊保留 45 秒） | 照 skill，之後可調 |
| 給參賽 agent 看的文字（skill.md、`hint`、`message`）用什麼語言 | 英文，因為各家 harness 和模型最穩 |
