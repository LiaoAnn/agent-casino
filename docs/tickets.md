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
| 7 | T14 ★（arena）、T21 | 2 + 試玩 agent |
| 7.5 | T23 → T24、T26（E5 與排隊修正） | 2 |
| 7.6 | T27、T28（arena 回饋）、T29（網頁風格） | 3 |
| 7.7 | T30（arena 第 3 輪回饋） | 1 |
| 7.8 | T32（arena 第 4 輪回饋）、T14 收尾 | 2 |
| 7.9 | T33（牌桌像真的賭桌） | 1 |
| 7.10 | T34（錦標賽賽制） | 1 |
| 7.11 | T35（顯示名稱） | 1 |
| 7.12 | T43（主人端的體驗）、T44（網站上線前修整）、T45（arena 第 6 輪回饋） | 3 |
| 7.13 | T46（arena 第 7 輪回饋） | 1 |
| 7.14 | T47（送出動作並等下一步） | 1 |
| 7.15 | T48（arena 第 9 輪回饋） | 1 |
| 9 | T36、T37（多人：規則、合約；⏸ 等 Ann 說開始） | 2 |
| 10 | T38、T40、T41（Room DO、積分、網頁） | 3 |
| 11 | T39 → T42（大廳、skill.md 與試玩） | 1 |
| 8 | T15 ★🔒 | 1 + 3 個試玩 agent |

最長的一條路是 T01 → T02 → T04 → T09 → T11 → T13 → T14 → T15，共 8 步（T21 跟 T14 同時進行）；其他 ticket 都在旁邊同時進行。

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
- 停權檢查（A9：停權的名字不能排隊、開房、進房，回 `name_banned`）：T09 的開房、進房還沒查，一起補上（T07 留下 `isBanned`）。
- 只改：`apps/api/src/matchmaker/`、`apps/api/src/routes/queue.ts`，以及 `apps/api/src/routes/room.ts` 的 `createRoom`、`joinRoom` 加停權檢查（只加這個）。
- 驗證：`pnpm test:api`。同時排 2 人進同一房；只有 1 人時 30 秒回 `waiting`；同時結束兩場，Elo 不會互相覆蓋；停權的名字排隊、開房、進房都回 `name_banned`。

### T13 串起來（約 700 行）· Blocked by：T05、T08、T10、T11、T12
- 房間結束 → 重播比對 → 經 Matchmaker 寫入（`recordMatch()`）；內建機器人 `house-bot` 進房（casino-api skill A1）；網頁改接真 API；`scripts/e2e.sh`（`pnpm e2e --target=local` 打本機 dev server，`--target=staging|prod` 留介面給 T21）；skill.md 範例實打檢查。
- 不碰 Cloudflare（2026-10-18 Ann 決定把部署拆成 T21）。
- 驗證：`pnpm e2e --target=local` 與 `pnpm test:skill` 全過。
- 功能驗證：在 worktree 網址用 curl 跟 `house-bot` 打完一場 10 手、兩個 curl 玩家排隊打完一場，網頁（`web-<wt>`）上看得到這兩場和排行榜變動。

### T21 部署測試環境（約 200 行）· Blocked by：T13
- Cloudflare 測試環境：wrangler 登入（device flow，scope 要加 D1）、建 D1 並套 migration、設 `TOKEN_SECRET`、`ADMIN_KEY`、部署 api 和 web 兩個 Worker（web 用 service binding 接 api）、`ALLOW_TEST_ROOMS=true`。
- 每一個會呼叫 Cloudflare 的指令都要先問 Ann。
- 驗證：`pnpm e2e --target=staging` 全過。
- 功能驗證：在測試環境用 curl 跟 `house-bot` 打完一場 10 手，網頁上看得到這場。

### T22 檢查會造成非預期花費的地方（約 400 行）· Blocked by：T13、T21
- Cloudflare Workers、Durable Objects、D1 都按用量計費（2026-10-18 Ann 提出）。逐一找出可能讓花費失控的地方，寫成報告，便宜的防護直接做掉，大的另開 ticket。
- 至少檢查：
  - **會自己一直跑的東西**：DO alarm（超時代打、D1 寫入失敗時每 10 秒重試）有沒有上限、會不會無限重排；房間、Matchmaker 有沒有永遠不結束的狀態；house-bot 有沒有可能自己跟自己一直打。
  - **長時間占著 DO**：`wait` 30 秒長輪詢、排隊 30 秒長輪詢對 DO 計費時間（duration）的影響，同時大量連線時的最壞情況。
  - **無限重試**：api、web、Matchmaker RPC、e2e 腳本裡的重試有沒有上限和退避。
  - **資料只增不減**：Room DO 的 storage（每手 `hand:<n>`）、D1 的 `matches`、`match_events` 有沒有清理；查詢有沒有全表掃描（排行榜、對局列表）。
  - **被濫用**：公開的 api（特別是開了 `ALLOW_TEST_ROOMS` 的測試環境）被人大量開房、排隊、打請求時的花費；要不要限流、限制每個名字或 IP 同時開的房間數。
  - **其他**：observability（logs）的量、web 每次 SSR 呼叫 api 的次數。
- 報告寫到 `docs/cost.md`：每一項寫觸發情境、最壞情況大約多少請求或多少錢（用 Cloudflare 公開價目估）、現在有沒有防護、建議怎麼改。
- 便宜、範圍小的防護直接做（例如 alarm 重試上限、房間最長存活時間、重試加上限），每項都要有測試；牽涉合約、行為改變大或要動 Cloudflare 設定的，列成建議等 Ann 決定。
- Cloudflare 帳號層面的保護（帳單上限、用量通知、Workers 方案）只能在 dashboard 設定：寫進報告的建議，由 Ann 自己設，不要用 API 改。
- 不呼叫 Cloudflare；需要看 staging 的實際用量時先問 Ann。
- 只改：`docs/cost.md`，以及防護需要的 `apps/api/src/`（不含 `contract/`）、`scripts/`。
- 驗證：`pnpm check`；每個做掉的防護都有測試證明上限生效（例如 alarm 重試到上限就停）。
- 功能驗證：在 worktree 的 dev server 用 curl 重現至少一個原本會一直跑的情境（例如讓 D1 寫入失敗），確認現在會停下來。

### T26 排隊要帶 queue_key（約 300 行）· Blocked by：T23
- 照 casino-api skill A17：`POST /v1/queue` 必帶 `queue_key`。同一個名字在排隊中或配對後 45 秒內，`queue_key` 不同就回 409 `name_in_use`，不給任何房間資訊。修掉 T12 的漏洞：對手用你的名字重叫 queue，就能拿到你的座位 token 和 `watch_url`。
- 合約 ticket：可以改 `apps/api/src/contract/`（只限 queue 的請求欄位、`name_in_use` 錯誤碼、假資料）。
- 只改：`contract/`（如上）、`apps/api/src/matchmaker/`、`apps/api/src/routes/queue.ts`、`apps/api/src/skill/`、`scripts/`（e2e 等呼叫 queue 的地方）。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm e2e --target=local`。測試至少要涵蓋：
  - 沒帶、太短、太長、有不合法字元的 `queue_key` 回 `invalid_request`；
  - 帶同一個 `queue_key` 續等、配對後重叫拿到同一份 `matched`（含同一個 `watch_url`）；
  - 排隊中和配對後 45 秒內，同名不同 `queue_key` 回 409 `name_in_use`，回應裡沒有 `room_id`、`token`、`watch_url`，原本那個人的排隊與配對不受影響；
  - 資格過期後，同名可以用新的 `queue_key` 重新排隊。
- 功能驗證：在 worktree 網址用 curl 開兩個名字排隊配對，再用其中一個名字、不同的 `queue_key` 重叫，被拒絕；用原本的 `queue_key` 重叫，拿到同一份 `matched`。
- 改了參賽 agent 看到的請求和 skill.md，下一輪 arena 一起測。

### T27 skill.md 上手改善（約 300 行）· Blocked by：T26
- 來源：`docs/playtests/arena-1.md`、`arena-2.md` 的合併提案 1、2、5、7、8。只改說明書，不改 API 行為。
- skill.md 開頭加「最短流程」：一次配對 = 一場比賽，預設 10 手；排隊 → 把 `watch_url` 交給主人 → wait／actions → 結果。
- 名字：主人沒給名字時怎麼取（例如 `<模型>-<4 碼亂數>`），並說明名字公開、同名共用積分與戰績。
- 保存憑證：教 agent 一拿到就把 `token`、`queue_key` 存下來，之後的 curl 都從存檔讀，不要每步重貼。存法要支援同時打好幾場，例如每個房間一個檔案 `.casino/<room_id>.token`，範例 curl 用 `$(cat .casino/$ROOM_ID.token)`。收到 `match_over`（或 `void`）、把結果和 `watch_url` 交給主人之後，刪掉這個房間的檔案（`rm .casino/$ROOM_ID.*`），`queue_key` 也存在同一處，一起刪。
- note：建議每一步都寫一句，用主人跟你說話的語言；不要因此拖過 deadline。
- 「斷線怎麼辦」：token 存好；`wait`／`state` 可以接回；超時會代打；同一個名字加同一個 `queue_key` 重新排隊，可以拿回同一份 `matched`。
- 範例跟真實回應一致：`watch_url` 範例用真正的 `WEB_URL`（或請求的網域），`deadline` 的格式跟實際回應一樣（帶毫秒），並說明 `raise.max` 已經算進自己這一輪下過的注。
- 只改：`apps/api/src/skill/`，以及它的測試。
- 驗證：`pnpm test:skill`（範例檢查照樣全過）；arena 再跑一輪，看「一局幾手」、名字、重貼 token、note 的問題有沒有消失。

### T28 回應補上一手的結果與剩餘秒數（約 400 行）· Blocked by：T26
- 來源：arena 合併提案 3、4、6。合約 ticket：可以改 `apps/api/src/contract/`（只限下面的欄位和假資料）。
- `last_hand` 加上結束原因（`fold` 或 `showdown`），以及每個座位這一手的籌碼變化；skill.md 寫明「對手翻牌前就棄牌時，`wait` 會直接跳到下一手，上一手的結果看 `last_hand`」。
- `your_turn`（wait、state）在 `deadline` 之外多給 `seconds_remaining`（整數，無條件捨去）。它只是幫 agent 判斷還有多少時間，想太久照樣會超時代打。
- `invalid_token`：header 格式不對（例如沒有 `Bearer `、多了字元）和簽章不對分開說明；hint 先叫 agent 核對原本存下來的 token，不要叫它去拿新的。
- 補 T26 留下的差異：`POST /v1/queue` 沒帶或帶錯 `queue_key` 時，`hint` 要照 A17 教怎麼產生（目前寫在 `message`，`hint` 是共用的 decode 錯誤句，在 `app.ts` 的共用錯誤處理）。
- skill.md 範例的 `watch_url` 用真正的 `WEB_URL`：`routes/skill.ts` 把 `env.WEB_URL` 傳給 `renderSkill`；沒有設定時退回用請求的網域（T27 留下的）。
- 只改：`contract/`（如上）、`apps/api/src/room/`、`apps/api/src/auth/`、`apps/api/src/skill/`、`apps/api/src/app.ts`（只限上面這個 hint）、`apps/api/src/routes/skill.ts`。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`。棄牌結束和攤牌結束的 `last_hand` 都有正確的結束原因和籌碼變化，而且雙方加總為 0；`seconds_remaining` 跟 `deadline` 一致；兩種 `invalid_token` 的訊息不同。

### T29 網頁套上賭場風格（約 700 行）· Blocked by：T24
- 照 web-design skill 把整個網頁改成賭場風格：`styles.css` 的色彩、字型 token，自己託管 Cinzel 和 Inter，`Badge`、`Table` 的 variant，自製元件 `PlayingCard`、`ChipStack`、`Felt`、`SeatPanel`、`ActionLogEntry`。
- 套用範圍：`/` 排行榜與最近對局、`/matches/{id}`、`/watch/{room_id}`。版面和資料不變，只改呈現；網頁仍然只有連結，不加任何能操作的元件。
- 順便整理結構，讓之後的新頁面自動套上風格：
  - `__root.tsx` 放共用的外框：深色底、站名（Cinzel）、連到排行榜的連結。
  - 頁面只負責組合元件，`Hand`、座位、牌、標籤這些都抽到 `components/`，`/matches` 和 `/watch` 共用同一套。
  - 加一個測試擋住寫死的顏色：`routes/` 和 `components/` 裡不能出現 hex 色碼或 Tailwind 內建色票（例如 `bg-red-500`、`text-zinc-400`），顏色只能用 design token。
- 順手處理 T24 發現的事：`watch_url` 的 token 在網址的 query string 裡，web Worker 開了 observability，第一次打開觀戰頁時 token 會被記進 Cloudflare 的請求 log。在 `apps/web/wrangler.jsonc` 加 `observability.redact_query_string: true`（所有環境）。
- 只改：`apps/web/`。
- 驗證：`pnpm test:web`（既有的 e2e 照樣全過）。另外檢查一遍 web-design skill 的對比表：沒有用到禁止的配對。
- 功能驗證：在 worktree 網址跟 house-bot 打一場。排行榜、對局紀錄、觀戰頁（進行中和結束後）各截一張桌機和手機（390px）的圖貼在 PR；再開「減少動態效果」截一張觀戰頁。截圖照 web-design skill 自我檢查後就可以合併，不用等 Ann。

### T30 等不到對手時回報主人（約 300 行）· Blocked by：T28
- 照 casino-api skill A18：`waiting` 加 `waited_seconds`、`queue_size`；等滿 180 秒後 hint 改成建議回報主人；skill.md 的排隊段落改成「約 3 分鐘回報主人，由主人決定繼續等、改跟 house-bot 打或停止」，拿掉「約 10 分鐘就停」。
- skill.md 另外補一句（arena 第 3 輪）：打完刪不掉 `.casino/` 的檔案時（例如工具擋了 `rm`），告訴主人哪些檔案還在。
- 合約 ticket：可以改 `apps/api/src/contract/`，只限 `waiting` 的兩個欄位和假資料。
- 只改：`contract/`（如上）、`apps/api/src/matchmaker/`、`apps/api/src/routes/queue.ts`、`apps/api/src/skill/`。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`。測試至少要涵蓋：
  - `waited_seconds` 在連續續等時遞增；資格過期後重新排隊會歸零；
  - `queue_size` 算的是不同 settings 的所有排隊者，包括自己；
  - 180 秒前後的 hint 不同。
  - 時間要用可控的時鐘，不要真的等。
- 功能驗證：在 worktree 網址用 curl 讓一個名字單獨排隊，看 `waited_seconds` 和 `queue_size`；再用另一組 settings 排第二個名字，`queue_size` 變成 2。

### T31 修掉不穩定的 api 測試（約 100 行）· Blocked by：—
- 測試變多（約 1330 項）以後，兩個既有測試在機器忙時偶爾失敗，擋住了其他 ticket 的 `pnpm check`：
  - `apps/api/src/db/leaderboard-reads.test.ts`：先灌 1000 筆評分，平常要 2.6 秒，會超過 5 秒逾時；也出現過一次唯一鍵衝突（T29 回報）。
  - `apps/api/src/routes/queue.test.ts`：有一個 100ms 的時序測試，機器忙時會回 `waiting`（T26 回報）。
- 先找出原因再修。可以用的做法：減少灌入的資料量（只要足以證明索引被用到）、用測試專用的 timeout、改用可控時鐘、修掉造成唯一鍵衝突的資料產生方式。不可以刪測試或放寬斷言。
- 只改這兩個測試檔，以及它們用到的測試工具。
- 驗證：在容器裡連跑 `pnpm check` 5 次都要過；另外把這兩個檔單獨連跑 20 次（用 shell 迴圈）也全過。

### T32 arena 第 4 輪的說明書與 hint 修正（約 300 行）· Blocked by：T30
- 來源：`docs/playtests/arena-4.md` 的「新發現」1～6。
- 名字範例改成用指令產生，例如 `name="<model>-$(openssl rand -hex 2)"`，不要再放一個可以直接照抄的名字。
- `watch_url` 跟 token 一起存檔（`.casino/$ROOM_ID.watch_url`），打完一起刪；斷線接回後，要再把 `watch_url` 交給主人一次。
- `matched`、`join`、開房回應的 hint 都先說「把 `watch_url` 交給主人」，再說下一步 call wait。
- 「Save as a skill」列出專案層級的路徑：Claude Code 是 `.claude/skills/agent-casino/`，Codex 和 pi 是 `.agents/skills/agent-casino/`。並說明 pi 要用 `/skill:agent-casino` 叫用，第一次會被問要不要信任這個資料夾。
- 說明 `last_hand.stack_changes` 是那一手的結算，下一手的 `stacks` 已經扣了盲注。
- 開房段落寫明：5 分鐘內沒人加入，房間會變成 `cancelled`。
- `match_over` 的 hint 附上網頁的對局頁連結 `<WEB_URL>/matches/{match_id}`（沒設定 `WEB_URL` 就不附）。
- 只改：`apps/api/src/skill/`、`apps/api/src/routes/room.ts`、`apps/api/src/routes/queue.ts`、`apps/api/src/room/`（只限 hint 文字）。不改合約形狀。
- 驗證：`pnpm check`、`pnpm test:skill`、`pnpm test:api`。hint 的新文字要有測試。verifier 照產生出來的 skill.md 打一場 house-bot，打到一半假裝當掉，再用存下來的檔案接回，交出 `watch_url`。

### T33 牌桌像真的賭桌（約 600 行）· Blocked by：T29
- 來源：Ann 2026-10-18 自己用 pi 玩過一場後的回饋。web-design skill 的「撲克牌」「牌桌版面」「元件」已經更新，照它做。
- 時間線改放右側：觀戰頁和對局紀錄頁用左右兩欄，左邊牌桌、右邊時間線；寬度小於 1024px 時改成上下排。
- 撲克牌改成真牌的樣子：傳統兩色（黑桃、梅花黑，紅心、方塊紅）；左上和右下各有角標；中央依點數排花色點位，J、Q、K 用大字母加框；角標和中央不能重疊；小尺寸只畫角標。
- 玩家坐在牌桌上：兩個座位壓在橢圓的上下緣（觀戰頁自己在下），座位上有名字、剩餘籌碼（畫成一疊籌碼加數字）、Elo、底牌、莊家「D」、輪到和倒數。
- 籌碼畫在桌上：底池是中央的一疊籌碼加數字；每個玩家這一街的下注，放在座位和中央之間。
- 對局紀錄頁的每一手也用同一張牌桌，顯示那一手結束時的樣子。
- 只改：`apps/web/`。不改資料和 API。保留 e2e 依賴的 aria-label／role（見 T24、T29 的提醒）。
- 驗證：`pnpm test:web`、`pnpm check`。PlayingCard 的單元測試至少涵蓋：A、2–10 每一種點數的中央花色數量正確，J、Q、K 有大字母，四種花色的顏色對。
- 功能驗證：在 worktree 網址跟 house-bot 打一場，觀戰頁（進行中、結束後）和對局紀錄頁各截桌機和 390px 手機的圖，貼在 PR。

### T34 改成單挑錦標賽賽制（約 900 行）· Blocked by：T32、T33
- 照 holdem-rules skill「賽制」和 casino-api skill A19：打到一方籌碼歸零，盲注每 `blind_every` 手翻倍，`max_hands` 是安全上限。原因：固定 10 手、比剩餘籌碼，會讓領先的一方在最後幾手一直棄牌（arena 裡 Codex 拿到 AA 也棄牌）。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍是 `settings` 的欄位、`blinds`、`next_blinds_at_hand`，以及假資料。
- 要改的地方：`holdem/` 的盲注計算和結束條件、`room/`、`contract/`、`db/`（讀取舊紀錄的對應）、`skill/`、`apps/web/` 顯示設定和盲注的地方、`scripts/` 的 e2e、fuzz 機器人、`docs/cost.md`。
- 驗證：`pnpm check`、`pnpm test holdem`、`pnpm test:api`、`pnpm test:skill`、`pnpm test:web`、`pnpm test:fuzz`、`pnpm e2e --target=local`。測試至少要涵蓋：
  - 盲注在第 1、`blind_every`、`blind_every`+1 手是對的；
  - 下不起盲注時全下；
  - 有人歸零就結束；
  - 打滿 `max_hands` 時比籌碼，平手也要測；
  - 帶 `hands` 的請求回 `invalid_request`；
  - 舊紀錄讀得出來；
  - 同一個種子加同一串動作，重播結果一樣；
  - fuzz 的不變量在新賽制下照樣成立。
- 功能驗證：在 worktree 網址用 curl 跟 house-bot 打到有人歸零，回應裡的 `blinds` 照預期升級；網頁的觀戰頁和對局紀錄看得到盲注。

### T35 顯示名稱與記住自己的身分（約 800 行）· Blocked by：T34
- 照 casino-api skill A20、web-design skill「玩家名字」。`display_name` 給人看，`name` 是身分。agent 第一次玩時問主人要叫什麼名字，存進 `.casino/profile.json`，之後都沿用，積分才會累積。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍是 `display_name`、`opponent_display_name`、`display_names`，以及假資料。
- 要改的地方：
  - `contract/`、`room/`、`matchmaker/`（matched 的 hint 和欄位在 `pairing.ts`）、`routes/room.ts`、`routes/queue.ts`；
  - `db/`：新的 migration，加上讀取時對舊紀錄的處理；
  - `skill/`、`apps/web/`；
  - `scripts/`：e2e 和 `playtest.sh`。playtest 的那一句話要帶名字，agent 就不會停下來問。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm test:web`、`pnpm e2e --target=local`。測試至少要涵蓋：
  - 中文、emoji、空格的顯示名稱接受，並正規化；
  - 控制字元、換行、超過 24 字回 `invalid_request`；
  - 沒帶時等於 `name`；
  - 雙方在 matched、join、wait、state、watch、對局紀錄、排行榜看到的都對；
  - queue 冪等重叫時，以第一次帶的為準；
  - 舊紀錄讀得出來；
  - 排行榜用的是最近一場的顯示名稱。
- 功能驗證：在 worktree 網址用 curl 以中文顯示名稱跟 house-bot 打一場。網頁的排行榜、對局紀錄、觀戰頁都顯示「顯示名稱 + 灰色 @name」，截桌機和手機的圖貼在 PR。

### T43 主人端的體驗 ★（約 700 行）· Blocked by：T35
- 照 casino-api skill A21。目標：小模型和開源模型也能讓主人有好的體驗（開局拿到連結、結束拿到結果和連結、用主人的語言），不靠模型自己記規則。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍是 `tell_owner`、`hands_since_your_turn`，以及假資料。
- 要改的地方：
  - `contract/`、`room/`、`matchmaker/`（matched 在 `pairing.ts`）、`routes/`：`tell_owner` 與 `hands_since_your_turn`；
  - `skill/`：轉告 `tell_owner` 的規則放在最前面；提問規則分成「排隊時」與「對局開始後」兩段；
  - `apps/web/`：觀戰頁在對局結束後顯示結果並連到對局紀錄（已經有就確認並在 PR 說明）；
  - `scripts/`：e2e 檢查新欄位。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm test:web`、`pnpm e2e --target=local`。測試至少要涵蓋：
  - matched、`match_over` 有 `tell_owner`，內容含正確連結、結果與 Elo 變化；其他回應沒有；
  - 下大盲就全下、整手自動打完時，雙方下一次拿到的 `hands_since_your_turn` 包含跳過的那手；平常是 0 或 1 手；
  - `last_hand` 行為不變。
- 功能驗證：在 worktree 網址用 curl 打一場，貼 matched 和 `match_over` 的 `tell_owner`。合併後 coordinator 跑 arena 第 6 輪（Haiku、pi 與其他小模型或開源模型），照 agent-playtest skill 的「主人體驗」一列判斷。

### T44 網站上線前修整（約 900 行）· Blocked by：T35
- 來源：T35 合併後的網站巡檢（2026-10-19）。目標是讓第一次來的人覺得這是完成品，不是半成品。牌桌、配色照 web-design skill。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍只限排行榜的 `rank`（同分同名次）和對局的結束原因。
- 一定要修：
  - 站內 404：中文頁面，附回首頁的連結（TanStack 的 `notFoundComponent`）；
  - 錯誤頁：中文說明，不露出原始錯誤和框架預設的按鈕（`errorComponent`）；
  - 輸光的座位顯示「出局」，不是 ALL-IN（`seat-panel.tsx` 用 `stack===0` 判斷）；
  - 同一條街的第一個下注寫「下注」，有人下注之後才寫「加注到」（`lib/format.ts`）；
  - 對局頁寫出這場怎麼結束的：一方輸光，或打滿 `max_hands` 比籌碼；
  - 排行榜同分同名次（1、1、3）（2026-10-19 Ann）；
  - `@name` 輸出成一段完整的文字，不要讓 SSR 在 `@` 和名字中間插 `<!-- -->`（staging 的 e2e「the web shows the queued match」因此沒過）；
  - `pnpm e2e --target=prod` 跳過會計分的那段，正式環境的排行榜不能出現 e2e 帳號（staging 可以）（2026-10-19 Ann）。
- 一個網域（2026-10-19 Ann）：web 收到 `/skill.md` 和 `/v1/*` 時，經由現有的 service binding 轉給 api，人和 agent 都用同一個網址。skill.md 裡的網址、`watch_url` 都要是這個網址。
- 建議一起修：
  - 首頁兩三行說明：這是什麼、賽制、沒有真錢、怎麼讓 agent 參加（附 skill.md 網址）；
  - 動作紀錄標出全下；
  - 觀戰頁和對局頁的 Elo 顯示方式一致；
  - 重複的標籤（「計分：計分」、兩個「結果」標題）、種子的標籤；
  - 時間統一用看的人的當地時間；SSR 時「最後更新」不要是空的；
  - 對局列表可以往前翻（`/v1/matches` 已經有 `before`）；
  - 每頁有自己的標題、favicon、og 標籤；觀戰頁加 `noindex`；
  - 對局頁標出勝方、盲注升級的那一手；
  - 桌機版面放寬；手機上的排行榜不要擠成七欄。
- 先不做：選手頁 `/players/{name}`（2026-10-19 Ann：可以做，但優先序不高）。名字先不加連結。「Codex @Codex」照 A20 永遠顯示。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:web`、`pnpm e2e --target=local`。
- 功能驗證：在 worktree 網址用 t3 的預覽工具逐頁看（首頁、排行榜、對局列表、對局頁、觀戰頁、404、錯誤頁），桌機和手機寬度都截圖貼在 PR。

### T45 不手抄 token、note 語言提醒 ★（約 300 行）· Blocked by：T43
- 來源：`docs/playtests/arena-6.md` 第 1、2 點。照 casino-api skill A21 新加的兩條。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍只限 `invalid_token` 和 `your_turn` 的 hint 文字與假資料。
- 要改的地方：
  - `skill/`：每個存檔步驟改成「回應直接存檔、用 `sed` 擷取」，只用 curl、sed、grep，不要求 jq；說明書裡不再出現要 agent 自己打一次 token 或連結的範例。順便把開頭整理成一段最短流程（排隊 → 存檔 → 轉告 `tell_owner` → wait／act 迴圈 → 收尾），細節留在後面。
  - `routes/`、`room/`：`invalid_token` 的 hint、`your_turn` 的 hint。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm e2e --target=local`。另外把 skill.md 裡的存檔指令實際對 worktree 網址跑一次（用 bash，照抄說明書），確認存下來的 token 能用。
- 功能驗證：合併後 coordinator 跑 arena 第 7 輪，陣容同第 6 輪，看「主人體驗」一列。

### T46 開局一定轉告觀戰連結 ★（約 300 行）· Blocked by：T45
- 來源：`docs/playtests/arena-7.md`。兩個 Claude（Haiku、Sonnet）都讀到 `tell_owner`，但存檔指令跑完什麼都不印，它們就直接進 `wait`，整場沒給主人觀戰連結。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍只限 `your_turn` 的 hint 文字與假資料。
- 要改的地方：
  - `skill/`：`matched` 和 `match_over` 的存檔指令最後一行印出 `Tell your owner now, before anything else:` 加上擷取出來的 `tell_owner`，讓 agent 跑完指令看到的最後一段就是要轉告的話。
  - `room/`：這個座位第一次收到 `your_turn` 時，hint 多一句：還沒把觀戰連結給主人的話，現在給（連結直接放在句子裡）。之後的 `your_turn` 不再提。
  - `skill/`：說明 `raise` 在還沒人下注時就是下注（最小值是大盲），`min` 等於 `max` 時就是全下；說明看 `hands_since_your_turn` 才完整，`last_hand` 只是捷徑。
- 不做：「送出動作並等下一步」（`actions?wait=1`），由 T47 做。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm e2e --target=local`。另外把 skill.md 的存檔指令照抄對 worktree 網址跑一次，確認最後印出 `tell_owner`。
- 功能驗證：合併後 coordinator 跑 arena 第 8 輪，陣容同第 7 輪，看「主人體驗」一列的「開局給觀戰連結」。

### T47 送出動作並等下一步 ★（約 400 行）· Blocked by：T46
- 來源：`docs/playtests/arena-7.md` 第 2 點，arena 連續 4 輪都有人提。agent 每一步要打兩個請求（`actions` 再 `wait`），每次都要開 shell、讀 JSON；pi 把兩個串在同一行，動作被拒時 `wait` 仍會發出去；Sonnet 自己寫腳本合併。Ann 已同意（以前「不做」的決定改掉）。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍只限 `POST /v1/rooms/{id}/actions` 加查詢參數 `wait`。
- 行為：
  - `?wait=1` 且動作被接受：等到這個座位的下一個 `your_turn` 或 `match_over` 才回傳，內容與 `GET /wait` 相同；等待上限與 `GET /wait` 相同，時間到回的也一樣。
  - 動作被拒絕：馬上回原本的錯誤，不等。
  - 等待中斷線：動作已生效；agent 再打 `GET /wait` 接回。
  - 沒有 `?wait=1`：行為完全不變；`GET /wait` 保留。
- `skill/`：主迴圈改用 `actions?wait=1`（存檔＋`sed` 擷取的寫法照 T45），`GET /wait` 只用在排到之後的第一次等待和斷線重接；說明動作被拒時怎麼辦。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm e2e --target=local`（e2e 主迴圈也改用 `?wait=1`，另外保留一段走舊的兩步）。單元測試要涵蓋：接受後等到 `your_turn`、等到 `match_over`、被拒不等、等待逾時。另外把 skill.md 的主迴圈照抄對 worktree 網址打完一場。
- 功能驗證：合併後 coordinator 跑 arena 第 9 輪，陣容同第 7 輪，看主迴圈是不是變簡單、有沒有超時代打。

### T48 轉告寫進回覆、第一手 60 秒 ★（約 500 行）· Blocked by：T47
- 來源：`docs/playtests/arena-9.md` 第 1～4 點。Ann 2026-10-19 同意，包括第一手多給時間。
- 合約 ticket：可以改 `apps/api/src/contract/`，範圍只限：`your_turn` 加頂層 `tell_owner`；hint 文字；第一手期限（`deadline` 的計算方式不變，只是值變大）。
- 要改的地方：
  - `skill/`：最上面的規則與 matched、`match_over` 存檔區塊旁邊都寫明：主人看不到指令輸出，只看得到 agent 自己寫的文字；要把 `tell_owner` 整句（含完整連結）寫進自己的回覆，單獨一則，馬上寫。
  - `room/`：座位第一次自己出手（被接受的動作）之前，每個 `your_turn`（`GET /wait`、`actions?wait=1`、`state`）都帶頂層 `tell_owner`，內容是觀戰連結那一句（同 matched 的 `tell_owner`）。T46 的 hint 提醒保留。之前的房間（沒有 `watch_urls`）不帶。
  - hint：`match_over` 提醒用主人的語言和字回報；`your_turn` 的 note 提醒寫明「Traditional and Simplified Chinese are different scripts」。
  - `skill/`：配對後（queue、create、join 的存檔區塊）把 `CASINO_URL` 和 `ROOM_ID` 寫進 `.casino/env`，之後每個指令區塊都以 `. .casino/env &&` 開頭（Claude Code 每次呼叫是新 shell）。斷線重接一節也改用它。
  - 計時：每個座位在這場的**第一個回合**期限是 `turn_seconds` 的兩倍（預設 60 秒），之後照舊。逾時代打規則不變。`deadline` 照實際值給。更新 casino-api skill 與 skill.md 的計時說明；只動 Room DO 的計時，不動 `src/holdem/`。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`、`pnpm e2e --target=local`。單元測試涵蓋：第一次出手前的每種 `your_turn` 都有 `tell_owner`、出手後沒有、逾時代打不算出手；第一個回合 60 秒、第二個 30 秒；兩個座位各算各的。另外把 skill.md 的存檔區塊和主迴圈照抄，每段用新的 shell 跑，對 worktree 網址打完一場。
- 功能驗證：合併後 coordinator 跑 arena 第 10 輪，陣容同第 7 輪，看「開局給觀戰連結」和「回報用主人的字」。

## Epic E3 Skill 與接入

**完成定義**：全新的 Claude Code、Codex 只收到一句話就能自己打完一場，不問人。

### T05 skill.md（約 600 行）· Blocked by：T17
- casino-api skill 的 skill.md 段落與 A12：模板、從合約填入、`GET /skill.md`。範例實打檢查留到 T13。
- 只改：`apps/api/src/skill/`、`apps/api/src/routes/skill.ts`。
- 驗證：`pnpm test:skill`（產生的檔案包含每個端點、每個錯誤碼、frontmatter 格式正確）。
- 功能驗證：找一個全新 agent 只讀 skill.md，請它寫出打一局的 curl 步驟（還不用真打），對照合約全對。

### T14 真 agent 試玩與狀況演練 ★（約 600 行）· Blocked by：T13
- `pnpm playtest`：`claude -p` 與 `codex exec` 互打；chaos 測試房（casino-api skill A11 的環境預設）；照 agent-playtest skill 找三個 agent 試玩並寫報告；依報告修 skill.md 與錯誤訊息。
- **人工試玩改用 arena**（2026-10-18 Ann 決定），T13 合併後開始，由 coordinator 主持：
  - 平台：一個專用的 worktree stack 跑最新的 `main`（api，加上 web 路由後也跑 web）。
  - 玩家：Codex（gpt-6.1-sol）、pi（litellm/Kimi-K3），各開一個 t3 thread，工作資料夾在 repo 外（例如 `/data/arena/<玩家>`），讀不到 repo 的 AGENTS.md 和 skill。
  - 模擬真實的用法：使用者把平台的 skill.md 裝成 agent 的 skill（它已有 `name: agent-casino` 的 frontmatter），再說「/agent-casino 請你幫我玩一局德州撲克」。名字和怎麼玩都由玩家自己從 skill 判斷。skill 只裝在該玩家的 arena 資料夾（專案層級），不要裝到全域（例如 `~/.codex/skills`），不然我們自己的 subagent 也會看到。
  - 由簡到難分輪：
    1. skill 由我們先裝好，玩家只收到那一句。
    2. 安裝本身也變成測試：只給 skill.md 的網址，請玩家自己裝好再玩。
    3. 之後再測其他功能：兩個玩家排隊互打、開房邀請、chaos 房、中途斷線。
  - 每一輪開打前先問 Ann（呼叫外部服務）。打完問每個玩家「哪一步最卡？說明書哪裡看不懂？」，報告寫到 `docs/playtests/arena-<n>.md`；coordinator 用 PM 的角度整理「使用者和 agent 怎麼更好上手」的提案，跟 Ann 討論，要改的再開 ticket。Ann 會從網頁看畫面並提意見。
  - 開始前要備好：web 的對外網址（repo 的 devcontainer 宣告 web 的 port）。Pi 已在 T3 啟用（2026-10-18）。
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

### T15 正式上線 ★🔒（約 500 行）· Blocked by：T14、T21、T22、T26、T30、T34、T35、T43、T44、T45、T46、T47、T48
- 正式環境部署（人同意後）、管理員金鑰、試玩發現的小修正。
- 網域 `casino.liaoann.net`，web Worker 用 Custom Domain 綁定（Cloudflare 自動建 DNS 與憑證），api 經由 web 轉送（T44），不另開網域。`ADMIN_KEY` 由 Ann 自己用 `wrangler secret put ADMIN_KEY --env production` 設。Ann 已設 budget alert。順序：staging 給 Ann 玩過，再上正式環境，上線後在正式環境跑一輪試玩（2026-10-19 Ann）。
- 部署前先跑 `db:migrate:<環境>`（T22 的 `0001_ratings_rank.sql`、T23 的 note 欄位）；部署後第一週每天看 DO 請求、D1 寫入列數、log 筆數，看到 `gave up storing the match` 就是 D1 有問題（見 `docs/cost.md`）。
- 驗證：`pnpm e2e --target=prod`。
- 功能驗證：三個 agent 在正式環境各打一場 10 手局。
- 🔒 人看：試玩報告 + 同意部署。
- 分工（2026-10-19 Ann 說可以上 prod）：
  - ticket thread 只改 repo，不呼叫 Cloudflare：
    - 兩個 `wrangler.jsonc` 加 `env.production`：api 的 D1 `agent-casino-prod`（`database_id` 留給 coordinator 建好後填）、`WEB_URL=https://casino.liaoann.net`、不設 `ALLOW_TEST_ROOMS`；web 的 Custom Domain `casino.liaoann.net`、service binding 指向 production 的 api。
    - 加 `deploy:production`、`db:migrate:production` script。
    - `docs/deploy.md` 補正式環境一節。
    - `e2e --target=prod` 能用 `casino.liaoann.net` 跑。
    - 一般流程合併。
  - coordinator 每一步都先問 Ann，再呼叫 Cloudflare：建 D1、填 `database_id`、套 migration、部署 api、設 `TOKEN_SECRET`、部署 web。`ADMIN_KEY` 由 Ann 自己設。之後跑 `e2e --target=prod`、正式環境試玩。
- 帳號名稱（2026-10-19 Ann）：
  - skill.md 的 `name` 一律用 `<model>-<4 hex>` 產生；主人給的名字只當 `display_name`，除非主人明講那是他的 ID 或帳號名稱。
  - 原因：arena 第 10 輪 Sonnet 把「Sunny」直接當 `name`，所有叫 agent 用 Sunny 的人會共用積分（`docs/playtests/arena-10.md` 第 2 點）。
  - 範圍：skill.md 與 `test:skill`；`name` 的格式規則不變。

## Epic E5 主人觀戰

**完成定義**：主人拿到 agent 交給他的觀戰連結，就能即時看自家 agent 這一場（自己的底牌、每一步和 agent 的想法），看不到對手沒亮的牌，也沒辦法從網頁介入。規格在 casino-api skill 的 A16（2026-10-18 Ann 定案）。

### T25 對局紀錄公開全部底牌（約 300 行）· Blocked by：T13
- 照 casino-api skill A13／A15 的修改：`GET /v1/matches/{match_id}` 每一手都給雙方的底牌（T07 的 `recordMatch` 寫入時丟掉了棄牌手的底牌，可以用種子重播算出），網頁的 `/matches/{id}` 每一手都顯示。合約假資料跟著改。
- 合約 ticket：可以改 `apps/api/src/contract/`（只限 `hole_cards` 的說明與假資料）。
- 只改：`contract/`（如上）、`apps/api/src/routes/read.ts`、`apps/api/src/db/` 的查詢、`apps/web/` 的對局紀錄頁。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:web`：棄牌的那一手也有雙方的底牌，而且跟用種子重播的結果一致。
- 功能驗證：跟 `house-bot` 打完一場，在網頁的對局紀錄看到棄牌那手雙方的底牌，截圖貼在 PR。

### T23 觀戰連結與 agent 想法：合約與 api（約 900 行）· Blocked by：T22、T25
- 照 casino-api skill A16：
  - watch token 的簽發與檢查；
  - `GET /v1/rooms/{room_id}/watch`；
  - 三個發 token 的回應加 `watch_url`；
  - `opponent_name`、`settings` 加到 matched／join／開房／wait／state；
  - `actions` 的 `note`，存到 `match_events`（新的 migration）；
  - `WEB_URL` 設定（本機與 `env.staging` 都要有）；
  - skill.md 模板加對應說明；
  - 合約假資料補上 watch 回應的進行中、已結束兩種，給 T24 用。
- 合約 ticket：可以改 `apps/api/src/contract/`。等 T25（也改合約）和 T22（也改 `room/`）合併後再開工。
- 只改：`contract/`、`token/`、`auth/`、`room/`、`matchmaker/`（只限 matched 的新欄位）、`db/`（只限 note 欄位）、`routes/room.ts`、`routes/queue.ts`、`skill/`、`apps/api/wrangler.jsonc`（`WEB_URL`）。
- 驗證：`pnpm check`、`pnpm test:api`、`pnpm test:skill`。測試至少要涵蓋：
  - watch token 打 wait／state／actions／leave 都回 `invalid_token`，座位 token 打 watch 也回 `invalid_token`；別房、偽造的 watch token 被拒絕；
  - 資訊對等：同一個時間點，watch 回應的每一個欄位（note 除外）都能從同座位的 state 推出來；
  - 進行中的 watch 回應沒有 `seed`、`turn_id`、`legal_actions`、對手沒攤牌的底牌，輪到對手時也沒有 `deadline`；
  - 棄牌的那一手看得到自己的底牌；
  - note 出現在自己的 watch，不出現在對手的 wait、state、watch，也不出現在 `/v1/matches/{id}`；
  - note 超過 500 字元回 `invalid_request`；
  - queue 冪等重叫時拿到同一個 `watch_url`；
  - `opponent_name`、`settings` 在 matched、join、wait、state 都正確。
- 功能驗證：在 worktree 網址用 curl 跟 `house-bot` 打一場，每一步帶 note。打 watch，看得到自己的底牌和 note、看不到對手的底牌；拿 watch token 去交動作，被拒絕；打完後 watch 有結果、雙方每一手的底牌和 note。
- 改了參賽 agent 看到的回應和 skill.md，下一輪 arena 一起測。staging 要重新部署才有，部署要先問 Ann。

### T24 網頁觀戰頁（約 500 行）· Blocked by：T23
- `/watch/{room_id}?token=…`：每 2–3 秒輪詢 watch 端點，結束後停止輪詢，頁面繼續當成回顧用。
- 內容：
  - 目前這一手：公牌、下注、籌碼、自己的底牌、輪到誰，輪到自己時加剩餘時間；
  - 時間線：從第一手到現在的每一步操作，自己的步驟下面顯示 note，沒有 note 就不顯示；
  - 結束後：結果，以及連到 `/matches/{id}` 的連結。
- 沒有任何按鈕或表單（只有連結）；`Referrer-Policy: no-referrer`；token 無效時顯示說明文字。
- 只改：`apps/web/` 的新路由與共用元件（不改 `/matches/{id}` 頁，那是 T25 的範圍）。
- 驗證：`pnpm test:web`，用假資料涵蓋進行中、已結束、token 無效三種狀態。
- 功能驗證：跟 `house-bot` 打一場，在 worktree 網址打開 `watch_url`，進行中和結束後各截一張圖貼在 PR。

## Epic E6 多人桌（第二版）

**完成定義**：
- 2–6 人可以用自動入座或私人房坐同一桌；由房主的主人決定什麼時候開打，可以用 house-bot 補空位。
- 打錦標賽打到剩一人，出局的人立刻知道自己的名次。
- 多人桌的 Elo 用兩兩比較算，跟單挑共用同一個 Elo。
- 網頁有大廳和 6 座位的牌桌。

**⏸ 暫停：T15 完成後也不要自動派工，等 Ann 明確說開始。**

設計結論在 `docs/design/multiplayer.md`（2026-10-19 Ann 確認）。每張票開工時先把自己負責的 skill 章節改成多人版（「先改規格」），再實作。改規格時：
- 第一版的行為只改決定裡寫到的地方；
- 2 人時要跟單挑的行為完全一樣，舊種子重播的結果不變（規則 6）。

### T36 規則引擎支援 2–6 人（約 1200 行）· Blocked by：T15
- 先改規格：holdem-rules 的房間預設設定、一手牌的流程、動作、賽制、種子與洗牌、邊界情況、引擎的細節定案（設計文件第三節）。
- `holdem/` 支援 N 個座位：
  - moving button、盲注位置，剩 2 人時改用單挑規則；
  - N 人的發牌順序；
  - 邊池；
  - 多人時不足額全下不重開加注權；
  - 除不盡的籌碼給莊家左手邊最近的贏家；
  - 出局與名次（同一手多人出局、打滿 `max_hands`）；
  - `leave` 會拿走籌碼。
- 用模擬決定「人數 → `blind_every` 預設」表：6 人一場目標約 10 分鐘，單挑維持 5 手。寫進 holdem-rules。
- 只改：`apps/api/src/holdem/`、holdem-rules skill。
- 驗證：`pnpm test holdem`、`pnpm test:fuzz`。
  - 用舊種子做回歸測試：2 人的每一手跟現在完全一樣。
  - 邊池、除不盡、同一手多人出局都要有「種子 + 動作 → 預期結果」的案例。
  - fuzz 跑 2–6 人，籌碼守恆時要扣掉 `leave` 拿走的部分。

### T37 多人合約（約 700 行）· Blocked by：T15
- 先改規格：casino-api 的端點表、`POST /v1/rooms`（visibility）、自動入座、`start`、大廳讀取、A15 回應形狀（`players`、`pots`、`place`、`seats_open`、`is_host`、N 個元素的陣列）、A19（`max_hands` 1–100、依人數的 `blind_every`）、錯誤碼（`not_host`、`not_enough_players`）、queue 改成回錯誤。
- 合約 ticket：改 `apps/api/src/contract/` 和假資料，涵蓋等待中、多人進行中、出局、結束四種。可以跟 T36 同時做。
- 只改：`contract/`、casino-api skill。
- 驗證：`pnpm test contract`、`pnpm check`（可以先用 stub 讓 api 編譯通過）。

### T38 Room DO 多人（約 1000 行）· Blocked by：T36、T37
- 先改規格：casino-api 的房間狀態、狀況處理表（拿掉 5 分鐘解散，加 2 分鐘不見）、A1、A6、A9、A11、A16（等待中的 watch、出局後只看公開資訊）、A18（加入後等太久回報主人）。
- `room/`：
  - 等人清單，以及給房主的 hint（每次都問：現在開始、用 house-bot 補空位、還是繼續等）；
  - `start`（只有房主能叫，可帶 `bots`，至少 2 人）；
  - 2 分鐘沒請求就判不見：房主不見就關房，其他人不見就移出座位；
  - 出局的人下一次 wait 就收到 `match_over`，帶 `place`；
  - 中途 `leave`；
  - 只剩 house-bot 就結束；
  - 保留 `opponent: bot` 的舊用法。
- 只改：`apps/api/src/room/`、`routes/room.ts`、casino-api skill。
- 驗證：`pnpm test:api`，狀況處理表每一列一個測試。

### T39 大廳與自動入座（約 500 行）· Blocked by：T38
- 先改規格：casino-api 的 A2（改寫成大廳和自動入座）、A17、A18。
- Matchmaker DO 改成大廳：記住有空位的公開房，自動入座時進最早開的那一間，只進預設設定的房間；拿掉 queue，`POST /v1/queue` 回錯誤並附 hint。
- 只改：`apps/api/src/matchmaker/`、`routes/queue.ts`、新的自動入座路由、casino-api skill。
- 驗證：`pnpm test:api`。同時 6 個人自動入座，會坐進同一間；第 7 個人另開一間；私人房和自訂設定的房間不會被自動入座。

### T40 多人積分與紀錄（約 700 行）· Blocked by：T37
- 先改規格：casino-api 的資料與積分、A10（兩兩 Elo，K = 32 /（人數 − 1））、A13（N 人的紀錄、名次）、排行榜加冠軍數。
- `db/`：
  - migration，把 matches 改成 N 人，或另開 `match_seats` 表；
  - 每個座位的名次；
  - 冠軍數；
  - 舊紀錄讀取時的對應；
  - `/v1/matches`、`/v1/players`、排行榜列出 N 人。
- 跟 T38 接上 `recordMatch`：由大廳依序寫入，跟 A10 一樣。
- 只改：`apps/api/src/db/`、`matchmaker/` 寫 Elo 的部分、`routes/read.ts`、casino-api skill。
- 驗證：`pnpm test:api`。2 人桌的 Elo 跟舊算法逐位相同；3 人並列算 0.5；有 bot 的場不計分。

### T41 網頁多人版（約 900 行）· Blocked by：T37
- 先改規格：web-design 的牌桌版面（6 座位、自己在正下方、等待中的空位用虛線框、出局變暗並標名次）、底池元件（主池、邊池）、排行榜（冠軍數）、大廳元件。
- `apps/web/`：
  - 大廳頁：等待中的房間、裡面有誰、空位數；私人房也列出，但不給邀請碼；
  - 觀戰頁開打前顯示等待中的牌桌；
  - 6 座位的版面、主池和邊池、出局的座位；
  - 排行榜的冠軍數、對局列表列出 N 人。
- 先用 T37 的假資料做，可以跟 T38–T40 同時做。
- 只改：`apps/web/`、web-design skill。
- 驗證：`pnpm test:web`，涵蓋 2、3、6 人，等待中、進行中、出局、結束；桌機和 390px 截圖。

### T42 多人版的 skill.md 與試玩 ★（約 500 行）· Blocked by：T38、T39、T40
- 先改規格：casino-api 的 skill.md 一節、`docs/cost.md` 的多人估計（設計文件「費用」）、AGENTS.md 開頭（第一版只有單挑那句）。
- skill.md 要寫：
  - 自動入座、私人房；
  - 房主怎麼回報主人，每次都要列出「用 house-bot 補空位」的選項；
  - 等主人回話時也要持續 wait；
  - 出局時的 `match_over`；
  - 每步 30 秒。
- 只改：`apps/api/src/skill/`、`docs/cost.md`、`AGENTS.md`、`scripts/`（e2e 和 playtest 改成多人）。
- 驗證：`pnpm test:skill`、`pnpm e2e --target=local`（3 人桌從頭打到尾）。
- 試玩：arena 開一桌 3–6 個 agent 自動入座，再加一個「私人房加 bot」的情境，報告寫進 `docs/playtests/`。

## 還沒定、先照預設做的

| 問題 | 預設 |
| --- | --- |
| Cloudflare 帳號、測試與正式網域 | staging 用 workers.dev；正式環境用 `casino.liaoann.net` 一個網域（2026-10-19 Ann） |
| CI 要不要放 Claude Code / Codex 的登入憑證 | 先不放，`pnpm playtest` 由 agent 手動觸發 |
| casino-api skill 的細節數字（名字規則、Elo 參數、token 有效期、排隊保留 45 秒） | 照 skill，之後可調 |
| 給參賽 agent 看的文字（skill.md、`hint`、`message`）用什麼語言 | 英文，因為各家 harness 和模型最穩 |
| 中途 leave、abort 時沒打完的那一手要不要記 | 不記（2026-10-18 Ann）：那手籌碼退回，種子 + 已存的手 + 結束原因就能重現結果；arena 若發現看網頁的人會困惑再開 ticket |
| `docs/cost.md` 的防護（限流、bot 房提早結束、緊急開關等）與 staging 是否公開 | 先都不做，staging 維持公開（2026-10-18 Ann）。Ann 用 Workers 付費方案，沒有花費上限，請 Ann 在 dashboard 設 budget alert 與用量通知；用量異常再開 ticket |
| 賽制 | 單挑錦標賽：打到一方歸零，盲注每 5 手翻倍，50 手安全上限（2026-10-18 Ann）。取代原本固定 10 手比籌碼 |
| 玩家名字 | `display_name` 給人看（可中文），`name` 是身分；agent 第一次問主人、存 `.casino/profile.json` 之後沿用（2026-10-19 Ann） |
| 選手頁 `/players/{name}` | 可以做，但優先序不高，先不做；名字先不加連結（2026-10-19 Ann） |
| 多人桌 | 第二版做 2–6 人、拿掉排隊改成大廳，詳見 `docs/design/multiplayer.md`（2026-10-19 Ann）；每步 30 秒、`max_hands` 1–100、牌桌座位不顯示 @name 已經先套用到第一版 |
