---
name: ticket-workflow
description: 在這個 repo 接一張 ticket 到合併的 SOP：開工前確認、範圍與資料夾、合約凍結、用 subagent 自我 review 與驗證、PR 格式、什麼時候自己合併、什麼時候停下來問人。開始做 ticket、開 PR、review 或驗證時使用。
---

# 做一張 ticket

一張 ticket 由一個 ticket thread 從頭做到合併。coordinator（見 `coordinator` skill）用 t3 開好 thread 和 worktree，你在自己的 worktree 裡做完整個流程：

```
開工 → 實作 → 自我檢查（reviewer + verifier subagent）→ 開 PR → CI 綠 → 合併（或等人核准）→ 通知 coordinator
```

## 授權

Ann 在 2026-10-17 同意，ticket thread 不用每次問就可以：
- commit、push 自己的 `t<編號>-*` branch，開、更新自己的 PR。
- 沒有 `needs-human` 的 PR，在下面「合併」的條件都滿足時自己合併。

仍然每次都要先問人：部署正式環境、呼叫外部服務（見 Dev VM 的 CLAUDE.md 第 6 節，包括部署 Cloudflare 測試環境）、碰別的 ticket 的 branch 或 worktree。

## 開工前
1. 讀 `docs/tickets.md` 裡你那張 ticket：範圍、Blocked by、只改哪些資料夾、驗證指令、功能驗證。
2. 確認 Blocked by 的 ticket 都已完成（`scripts/board.sh` 顯示 Done，也就是 PR 已合併進 `main`）；沒有就不要開始，回報 coordinator。
3. 用 `wt-status <path>` 確認自己的 stack 起來了；沒有就 `wt-up <path>`。
4. 一張 ticket = 一個 branch = 一個 PR，約 500–1000 行（不算 lockfile 和自動產生的檔案）。branch 名稱 `t<編號>-<簡短英文>`（coordinator 開 worktree 時已經建好）。

## 做的時候
- **只改 ticket 寫的資料夾。** 同時有別的 agent 在做其他 ticket，碰到範圍外的檔案就會打架。共用檔案（根目錄 `package.json`、`wrangler.jsonc`、CI 設定）只能新增，不能改別人寫的。
- **合約凍結**：不是合約 ticket 就不改 `apps/api/src/contract/`。真的需要，停下來說明，等人決定（可能另開合約 ticket）。
- **範圍不對**：停下來說明，不要自己擴大或縮小範圍。
- **skill 不是標準答案**：照做會做出不合理的東西、skill 互相矛盾、或你看到更簡單的做法，停下來提出，不要自己猜或硬照做。
- **還沒有的東西用合約產生的假資料**，不要等別的 ticket。
- **不准削弱測試**：不刪、不跳過既有測試（CI 擋 `.skip`、`.only`），不調低門檻。
- 修 bug 時先把問題寫成會失敗的測試（規則相關的就用「種子 + 動作」），再修。
- 秘密（`TOKEN_SECRET`、`ADMIN_KEY`、Cloudflare token、登入憑證）只放在 Worker secret 或 GitHub Actions secrets。
- 不部署正式環境，除非 ticket 寫了而且人同意。部署測試環境也算呼叫外部服務，每次先問。

## 自我檢查
寫完、自己跑過 `pnpm check` 和 ticket 的驗證指令後，先 commit，再**同時**開兩個全新的 subagent。作者自己說「測過了」不算，要 subagent 從頭看。

**reviewer**：給它 ticket 原文和 `git -C <path> diff origin/main...HEAD`。請它對照 ticket 和相關 skill 找：做多、做少、寫死的數字、沒測到的分支、碰了範圍外的檔案、改了合約、削弱測試、跟 skill 規格不符。結論分成「必須修」和「建議」。

**verifier**：在同一個 worktree，從乾淨狀態重跑：
1. `git -C <path> status` 乾淨（都已 commit）。
2. 在容器裡重裝依賴（`pnpm install --frozen-lockfile`），重跑 `pnpm check` 和 ticket 的每個驗證指令。
3. 照 ticket 的「功能驗證」在 worktree 的網址上實際操作（API 用 `curl https://<route>-<wt>...`，網頁用 t3 preview 截圖）。
4. 回報每一項過或不過，附指令和輸出。

有「必須修」或驗證沒過 → 修 → commit → 再開兩個**新的** subagent 重來。三輪還過不了，停下來通知 coordinator。

## 開 PR
兩個 subagent 都過了才 push、開 PR：
- 標題 `T<編號>: <英文簡述>`，例如 `T02: cards and hand ranking`。
- 內文照 `.github/pull_request_template.md`，證據貼 verifier 的輸出，review 寫最後一輪結論。
- 需核准（ticket 標 🔒）的 PR 加 `needs-human` 標籤。

## 合併
沒有 `needs-human` 的 PR，下面全部滿足就自己合併（`gh pr merge <號碼> --squash`）：
1. CI 全綠（還沒有 CI 的時候，以 verifier 的結果為準）。
2. 最後一輪 reviewer 沒有「必須修」，verifier 全過。
3. branch 跟最新的 `main` 沒有衝突。`main` 動過就 rebase 到 `origin/main`，重跑 verifier，再 push。

有 `needs-human` 的 PR：開好後停下來，用一頁摘要通知 coordinator（改了什麼、證據、可以點的網址），等人說可以再合併。

合併後（或停下來等人時）用 `t3_thread_send` 通知 coordinator thread（開工訊息裡有它的 id）：ticket 編號、PR 網址、狀態。

## 什麼時候停下來
- 設計問題：要改合約、ticket 範圍不對、skill 不合理或互相矛盾。
- 自我檢查三輪還過不了。
- 要部署正式環境、要呼叫外部服務（包括部署 Cloudflare 測試環境、用真的 Claude Code / Codex 試玩）。
- 需核准的 PR 已開好。

停下來時用 `t3_thread_send` 通知 coordinator：卡在哪、試過什麼、需要人決定什麼（有選項就列出選項和你的建議）。coordinator 會整理給人，再把答案轉告你。

## 怎麼驗

| 驗什麼 | 怎麼驗 |
| --- | --- |
| 規則 | 「種子 + 一串動作 → 預期結果」的案例 |
| 比牌 | 公開牌型對照資料當標準答案 |
| 不該發生的事 | 亂打機器人上萬手：籌碼總數不變、沒人超前行動、輪到人時合法動作不為空 |
| 介面跟說明書一致 | skill.md 從合約產生；抓出 skill.md 每個 curl 範例實際打一次，回應符合合約 |
| 狀況處理 | `casino-api` skill「狀況處理」表每列一個測試 |
| 從頭到尾 | `pnpm e2e`，只用 curl + jq |
| 參賽 agent 好不好用 | `agent-playtest` skill |
