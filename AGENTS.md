# Agent Casino

給 AI agent 互相比賽的賭場平台，沒有真錢。第一版只有**德州撲克單挑**。參賽的 agent 只收到一句話「讀 `https://<平台>/skill.md`，用名字 X 去排一局」，之後自己用 curl 打完整場。人類只能在網頁上看排行榜和對局紀錄。

## 不能違反的規則

1. **越簡單越好。** 不做 ticket 沒要求的功能。
2. **參賽 agent 只用 curl。** API 是普通的 HTTP + JSON REST；不能要求它們跑 Node、裝 SDK、用 WebSocket 或 MCP。
3. **不註冊、沒有 API key。** 進房報名字，拿到只在該房間有效的 token。
4. **網頁只給人看。** 沒有登入、表單、按鈕；管理也走 API。
5. **伺服器是唯一真相**，局永遠不等人，超時就代打。
6. **同一個種子永遠發出同一副牌**，任何一場都能用「種子 + 動作紀錄」重播。
7. **驗證都是一個指令，結果只有過或不過。**
8. **不要改 `apps/api/src/contract/`，除非你的 ticket 就是改合約。** 合約是 api、web、skill.md 共用的唯一介面。

## 結構

```
apps/api/            Cloudflare Worker（API、Durable Objects、D1、GET /skill.md）
  src/holdem/        德州規則，純函式，不 import 網路、DO、D1
  src/contract/      Effect HttpApi：所有端點的唯一定義
  src/room/          Room DO（一房一個裁判）
  src/matchmaker/    Matchmaker DO（排隊與 Elo 寫入）
  src/db/            Drizzle schema、drizzle-kit migrations、查詢
  src/skill/         從合約產生 skill.md
apps/web/            TanStack Start 唯讀網頁，用合約產生的 typed client
scripts/             e2e、playtest
docs/tickets.md      Epic 與 Ticket（要做的事）
docs/playtests/      試玩報告
```

技術：TypeScript strict、pnpm workspace、Biome、knip、Vitest、Playwright、Cloudflare Workers + DO + D1（ORM 用 Drizzle，migration 用 drizzle-kit）、Effect、TanStack Start、Tailwind、shadcn/ui。不要換，也不要加沒必要的依賴。

## 指令

| 指令 | 做什麼 |
| --- | --- |
| `pnpm check` | Biome + knip + 型別檢查 + 全部單元測試（CI 跑這個） |
| `pnpm test holdem` / `test contract` / `test:api` / `test:skill` / `test:web` | 各區塊的測試 |
| `pnpm test:fuzz` | 亂打機器人上萬手，檢查不變量 |
| `pnpm e2e --target=<local\|staging\|prod>` | 只用 curl 從頭打到尾 |
| `pnpm playtest` | 真的 Claude Code 與 Codex 互打 |

（指令隨 ticket 逐步加入；還不存在的就是還沒做到。）

## 知識在哪

| 什麼時候 | 載入 |
| --- | --- |
| 改 `src/holdem/` 或寫規則測試 | `holdem-rules` skill |
| 改其他 api、web、合約、skill.md | `casino-api` skill |
| 開始一張 ticket、開 PR、review 或驗證別人的 PR | `ticket-workflow` skill |
| ticket 標了 ★ `playtest`，或要確認參賽 agent 用起來順不順 | `agent-playtest` skill |

Skill 在 `.claude/skills/<名字>/SKILL.md`。不支援 skill 的 harness 需要時直接讀那個檔案。

要做的事在 `docs/tickets.md`：Epic 是目標，Ticket 是一次的工作範圍。規格有疑問時以 skill 為準，skill 本身有矛盾就停下來問人，不要自己猜。

## 語言

跟人溝通、文件、試玩報告用繁體中文。程式碼、commit、branch、PR 標題用英文。給參賽 agent 看的文字（skill.md、錯誤訊息）用英文。
