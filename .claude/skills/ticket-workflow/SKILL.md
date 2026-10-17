---
name: ticket-workflow
description: 在這個 repo 接一張 ticket 到合併的 SOP：開工、/plan-it、/implement-plan（含 /tdd、檢查、驗收、/review-change）、獨立驗證、PR、合併、什麼時候停下來問人。開始做 ticket、開 PR、review 或驗證時使用。
---

# 做一張 ticket

一張 ticket 由一個 ticket thread 從頭做到合併。coordinator（見 `coordinator` skill）用 t3 開好 thread 和 worktree，你在自己的 worktree 裡做完整個流程：

```
開工 → /plan-it → /implement-plan（每個 slice：/tdd → 實作 → 檢查 → 驗收 → /review-change → commit）
     → 整體 /review-change → 獨立驗證 → 開 PR → CI 綠 → 合併（或等人核准）→ 通知 coordinator
```

`/plan-it`、`/implement-plan`、`/tdd`、`/review-change`、`/verification-evidence`、`/diagnose-bug` 是使用者層級的 skill（`~/.claude/skills/`），這份 SOP 只補充這個 repo 的規定。

## 授權

Ann 在 2026-10-17 同意，ticket thread 不用每次問就可以：
- commit、push 自己的 `t<編號>-*` branch，開、更新自己的 PR。
- 計畫不用等人核准就開始實作（計畫裡出現新的設計決策時除外，見「什麼時候停下來」）。
- 沒有 `needs-human` 的 PR，在下面「合併」的條件都滿足時自己合併。

仍然每次都要先問人：部署正式環境、呼叫外部服務（見 Dev VM 的 CLAUDE.md 第 6 節，包括部署 Cloudflare 測試環境）、碰別的 ticket 的 branch 或 worktree。

## 1. 開工
1. 讀 `AGENTS.md`、`docs/tickets.md` 裡你那張 ticket（範圍、Blocked by、只改哪些資料夾、驗證指令、功能驗證），再讀 ticket 指到的 skill（`holdem-rules`、`casino-api`…）。
2. 確認 Blocked by 的 ticket 都已完成（`scripts/board.sh` 顯示 Done，也就是 PR 已合併進 `main`）；沒有就不要開始，通知 coordinator。
3. 看前面 ticket 留下了什麼：`git -C <path> log --oneline origin/main` 和相關 PR 的內文（`gh pr view <號碼>`），了解現在的程式碼長怎樣、別人已經做好哪些可以用。
4. 用 `wt-status <path>` 確認自己的 stack 起來了；沒有就 `wt-up <path>`。
5. 一張 ticket = 一個 branch = 一個 PR，約 500–1000 行（不算 lockfile 和自動產生的檔案）。branch 名稱 `t<編號>-<簡短英文>`（coordinator 開 worktree 時已經建好）。

## 2. 計畫：`/plan-it`
- **Why** 從 ticket 和 Epic 的完成定義來：這張 ticket 給誰用（後面哪些 ticket 依賴它、參賽 agent、看網頁的人）。
- **What** 的每個 slice 都要有 Acceptance：在真的系統上怎麼證明（指令、curl、頁面），對應 ticket 的驗證指令和功能驗證。
- **Validation and Authority** 這樣填：
  - TDD：改變行為的 slice 一律 `yes`（規則、API、資料）。純設定、骨架可以寫明豁免理由。
  - 專案驗證：這個 repo 還沒有 verify skill，驗收照 ticket 的「驗證」和「功能驗證」在 worktree 網址上做。
  - Commit：每個 slice 通過後自動 commit。
  - 需要核准：只有新的設計決策（見「什麼時候停下來」）。
- 計畫留在 thread 裡，開 PR 時把 Why 和 slice 清單摘要寫進「做了什麼」。

## 3. 實作：`/implement-plan`
照 `/implement-plan` 的 slice loop 走，這個 repo 的補充：

- **只改 ticket 寫的資料夾。** 同時有別的 agent 在做其他 ticket，碰到範圍外的檔案就會打架。共用檔案（根目錄 `package.json`、`wrangler.jsonc`、CI 設定）只能新增，不能改別人寫的。
- **合約凍結**：不是合約 ticket 就不改 `apps/api/src/contract/`。真的需要，停下來說明，等人決定（可能另開合約 ticket）。
- **還沒有的東西用合約產生的假資料**，不要等別的 ticket。
- **不准削弱測試**：不刪、不跳過既有測試（`.skip`、`.only` 會讓 `pnpm check` 失敗），不調低門檻。
- 修 bug 先用 `/diagnose-bug` 重現，寫成會失敗的測試（規則相關的就用「種子 + 動作」），再修。
- 秘密（`TOKEN_SECRET`、`ADMIN_KEY`、Cloudflare token、登入憑證）只放在 Worker secret 或 GitHub Actions secrets。
- 指令都在容器裡跑：`T3CODE_WORKTREE_PATH=<path> wt-exec bash -lc "<指令>"`。

**檢查（slice loop 第 4 步）** 一律跑 `pnpm check`，它依序是：
| 檢查 | 指令 | 管什麼 |
| --- | --- | --- |
| lint + format | `biome check .` | 程式風格、格式、`.skip`/`.only` |
| 死碼 | `knip` | 沒用到的檔案、export、依賴 |
| 型別 | `pnpm typecheck` | TypeScript strict |
| 測試 | `pnpm test` | 全部單元測試 |

格式不對就 `pnpm format` 修。knip 在這台 VM 會吃光記憶體，跑之前先 `export KNIP_DISABLE_RAW_TRANSFER=1`（不要寫進 repo）。

**驗收（slice loop 第 5 步）** 照 `/verification-evidence` 拿 Observed 的證據：API 用 `curl https://<route>-<wt>.<vm>.liaoann.net/...`（網址看 `wt-status`），網頁用 t3 preview 截圖。需要 dev server 時開在 tmux（`<wt>-api`），用完就關，VM 記憶體很少。

**Review（slice loop 第 6 步與最後）** 每個 slice 跑 `/review-change`，最後整個 branch 再跑一次（finished-feature 的 lenses）。給 reviewer 的 plan 要附 ticket 原文，讓它也檢查：做多、做少、寫死的數字、碰了範圍外的檔案、改了合約、跟 skill 規格不符。有 Blocker 就修，重跑受影響的檢查和驗收。

## 4. 獨立驗證
全部 slice 做完、整體 review 沒有 Blocker 後，開一個**全新的 verifier subagent**。作者自己的驗收不算數。給它 ticket 原文、worktree 路徑和網址，請它照 `/verification-evidence`：
1. 確認 `git -C <path> status` 乾淨（都已 commit）。
2. 在容器裡重裝依賴（`pnpm install --frozen-lockfile`），重跑 `pnpm check` 和 ticket 的每個驗證指令。
3. 自己起 dev server，照 ticket 的「功能驗證」在 worktree 網址上實際操作。
4. 每一項回報過或不過，附指令和輸出；做不到的標 inconclusive。

沒過就回到 `/implement-plan` 修，再開一個新的 verifier。三輪還過不了，停下來通知 coordinator。

## 5. 開 PR
獨立驗證過了才 push、開 PR：
- 標題 `T<編號>: <英文簡述>`，例如 `T02: cards and hand ranking`。
- 內文照 `.github/pull_request_template.md`：「做了什麼」放計畫摘要，「驗證」貼 verifier 的輸出，「Review」寫整體 `/review-change` 的結論和 Residual Risk。
- 需核准（ticket 標 🔒）的 PR 加 `needs-human` 標籤。

## 6. 合併
沒有 `needs-human` 的 PR，下面全部滿足就自己合併（`gh pr merge <號碼> --squash`）：
1. CI 全綠。
2. 整體 `/review-change` 沒有 Blocker，verifier 全過。
3. branch 跟最新的 `main` 沒有衝突。`main` 動過就 rebase 到 `origin/main`，重跑 verifier，再 push。

有 `needs-human` 的 PR：開好後停下來，用一頁摘要通知 coordinator（改了什麼、證據、可以點的網址），等人說可以再合併。

合併後關掉自己的 tmux dev server，用 `t3_thread_send` 通知 coordinator thread（開工訊息裡有它的 id）：ticket 編號、PR 網址、狀態，以及給後面 ticket 的提醒（留下了什麼、還沒做什麼、踩過的坑）。

## 什麼時候停下來
- 設計問題：要改合約、ticket 範圍不對、skill 不合理或互相矛盾、看到更簡單的做法、計畫裡出現 skill 沒定的設計決策。Skill 是目前最好的版本，不是標準答案，不要自己猜或硬照做。
- 獨立驗證三輪還過不了。
- 要部署正式環境、要呼叫外部服務（包括部署 Cloudflare 測試環境、用真的 Claude Code / Codex 試玩）。
- 需核准的 PR 已開好。

停下來時用 `t3_thread_send` 通知 coordinator：卡在哪、試過什麼、需要人決定什麼（有選項就列出選項和你的建議）。coordinator 會整理給人，再把答案轉告你。

## 這個 repo 怎麼驗

| 驗什麼 | 怎麼驗 |
| --- | --- |
| 規則 | 「種子 + 一串動作 → 預期結果」的案例 |
| 比牌 | 公開牌型對照資料當標準答案 |
| 不該發生的事 | 亂打機器人上萬手：籌碼總數不變、沒人超前行動、輪到人時合法動作不為空 |
| 介面跟說明書一致 | skill.md 從合約產生；抓出 skill.md 每個 curl 範例實際打一次，回應符合合約 |
| 狀況處理 | `casino-api` skill「狀況處理」表每列一個測試 |
| 從頭到尾 | `pnpm e2e`，只用 curl + jq |
| 參賽 agent 好不好用 | `agent-playtest` skill |
