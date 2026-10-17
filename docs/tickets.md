# Agent Casino：Epic 與 Ticket

要做的事都寫在這份。Epic 是目標，Ticket 是一次的工作範圍；規格不寫在這裡，而是指向 skill。不開 GitHub issue。

一張 ticket 算完成 = 它的 PR（branch `t<編號>-<簡短英文>`）已合併進 `main`。開工前怎麼確認、怎麼開 PR，見 `ticket-workflow` skill。

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
- 🔒 `needs-human`：要人核准才能合併的 ticket。PR 加上這個標籤。
- ★ `playtest`：要找 3 個全新 agent 試玩的 ticket。PR 加上這個標籤。

## 排程參考：分波（同一波可同時派給不同 agent）

| 波 | Ticket（可同時做） | 需要幾個 agent |
| --- | --- | --- |
| 1 | T01 | 1 |
| 2 | T02、T03 🔒 | 2 |
| 3 | T04、T05、T06、T07 | 4 |
| 4 | T08、T09、T10 | 3 |
| 5 | T11、T12 | 2 |
| 6 | T13 | 1 |
| 7 | T14 ★🔒 | 1 + 3 個試玩 agent |
| 8 | T15 ★🔒 | 1 + 3 個試玩 agent |

最長的一條路是 T01 → T02 → T04 → T09 → T11 → T13 → T14 → T15，共 8 步；其他 ticket 都在旁邊同時進行。

## Epic E0 地基

**完成定義**：任何 agent clone 下來，`pnpm check` 一個指令就知道過不過。

### T01 Monorepo 骨架（約 500 行）· Blocked by：無
- pnpm workspace（`apps/api`、`apps/web`）、TS strict、Biome、knip、Vitest、GitHub Actions、`pnpm check`、CI 擋 `.skip` / `.only`。保留 repo 裡已有的 AGENTS.md、`.claude/skills/`、`docs/`、`.github/` 檔案。
- `apps/api` 是一個 Worker，有 `GET /health` 回 `{"ok":true}`，wrangler 設定好 DO 與 D1 綁定。
- 只改：根目錄設定、`.github/`、`apps/*` 的骨架。
- 驗證：`pnpm check` 全過。功能驗證：啟動 api 後 `curl /health` 回 ok。

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

## Epic E2 合約與對局服務

**完成定義**：兩個只會 curl 的玩家能在測試環境排隊、打完一場、看到排行榜變動。

### T03 API 合約與房間 token 🔒（約 700 行）· Blocked by：T01
- 用 Effect HttpApi 定義 casino-api skill 的**所有**端點、請求、回應、錯誤（含 HTTP 狀態碼）；token 簽發與檢查；從合約產生假資料的工具（給 T06、T10 用）。
- 只改：`apps/api/src/contract/`、`apps/api/src/token/`。
- 驗證：`pnpm test contract`。功能驗證：偽造、過期、拿別房的 token 都被拒絕。
- 🔒 人看：端點與欄位命名、錯誤訊息的寫法。

### T07 紀錄、積分與讀取端點（約 700 行）· Blocked by：T03
- Drizzle schema 與 drizzle-kit migrations（D1）、`recordMatch()`（給房間結束時呼叫）、Elo 計算、`leaderboard`、`matches`、管理員停權。
- 只改：`apps/api/src/db/`、`apps/api/src/routes/read.ts`、`apps/api/src/routes/admin.ts`。
- 驗證：`pnpm test:api`。功能驗證：直接呼叫 `recordMatch()` 寫入兩場，用 curl 看排行榜分數正確。

### T09 房間裁判（約 1000 行）· Blocked by：T03、T04
- Room DO（一房一個）：開房、邀請碼進房、`wait`（30 秒長輪詢）、`state`、`actions`（casino-api skill A3 的 `turn_id` 規則）、`leave`。
- 只改：`apps/api/src/room/`、`apps/api/src/routes/room.ts`。
- 驗證：`pnpm test:api`。功能驗證：開兩個終端機用 curl 自己跟自己打完 1 手。

### T11 超時與狀況處理（約 600 行）· Blocked by：T09
- DO alarm 超時代打、連 3 次離席、5 分鐘解散、非法 / 太晚 / 重複 / 離開、測試房的 `test.seed` 與 `test.chaos`（casino-api skill A11）。
- 只改：`apps/api/src/room/`。
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

### T05 skill.md（約 600 行）· Blocked by：T03
- casino-api skill 的 skill.md 段落與 A12：模板、從合約填入、`GET /skill.md`。範例實打檢查留到 T13。
- 只改：`apps/api/src/skill/`、`apps/api/src/routes/skill.ts`。
- 驗證：`pnpm test:skill`（產生的檔案包含每個端點、每個錯誤碼、frontmatter 格式正確）。
- 功能驗證：找一個全新 agent 只讀 skill.md，請它寫出打一局的 curl 步驟（還不用真打），對照合約全對。

### T14 真 agent 試玩與狀況演練 ★🔒（約 600 行）· Blocked by：T13
- `pnpm playtest`：`claude -p` 與 `codex exec` 互打；chaos 測試房（casino-api skill A11 的環境預設）；照 agent-playtest skill 找三個 agent 試玩並寫報告；依報告修 skill.md 與錯誤訊息。
- 驗證：`pnpm playtest`。
- 功能驗證：agent-playtest skill 的「能用」全過。
- 🔒 人看：試玩報告。

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
