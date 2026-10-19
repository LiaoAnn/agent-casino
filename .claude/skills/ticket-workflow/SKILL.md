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

仍然每次都要先問人：部署正式環境、呼叫外部服務（見 Dev VM 規則的「External services」，包括部署 Cloudflare 測試環境）、碰別的 ticket 的 branch 或 worktree。

## 1. 開工
1. 讀 `AGENTS.md`、`docs/tickets.md` 裡你那張 ticket（範圍、Blocked by、只改哪些資料夾、驗證指令、功能驗證），再讀 ticket 指到的 skill（`holdem-rules`、`casino-api`…）。
2. 確認 Blocked by 的 ticket 都已完成（`scripts/board.sh` 顯示 Done，也就是 PR 已合併進 `main`）；沒有就不要開始，通知 coordinator。
3. 看前面 ticket 留下了什麼：`git -C <path> log --oneline origin/main` 和相關 PR 的內文（`gh pr view <號碼>`），了解現在的程式碼長怎樣、別人已經做好哪些可以用。
4. 用 `wt-status <path>` 確認自己的 stack 起來了；沒有就 `wt-up <path>`。
5. 一張 ticket = 一個 branch = 一個 PR，約 500–1000 行（不算 lockfile 和自動產生的檔案）。branch 名稱 `t<編號>-<簡短英文>`（coordinator 開 worktree 時已經建好）。

## 2. 計畫：`/plan-it`
- **Why** 從 ticket 和 Epic 的完成定義來：這張 ticket 給誰用（後面哪些 ticket 依賴它、參賽 agent、看網頁的人）。
- **What** 的每個 slice 都要有 Acceptance：在真的系統上怎麼證明（指令、curl、頁面），對應 ticket 的驗證指令和功能驗證。
- **How** 要把每個 slice 的公開介面定下來（函式簽名、回應形狀），test-author 和實作者都照這份寫。
- **Validation and Authority** 這樣填：
  - TDD：改變行為的 slice 一律 `yes`，並標出它是哪一級（見下面「測試由誰寫」）。純設定、骨架、刪除可以寫明豁免理由。
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

**測試由誰寫（slice loop 第 1 步）** 分兩級：

| 級別 | 哪些 slice | 怎麼做 |
| --- | --- | --- |
| 拆開寫 | 規則（`holdem/`）、合約、token、API handler、DO、資料庫：碰到公開介面、持久資料或別的 ticket 會用的模組 | 照下面三步，**依序**做，不可以同時進行 |
| 自己寫 | 設定、膠水程式、純搬移或刪除 | 同一個 agent 照 `/tdd` 做 red → green，或寫明豁免理由 |

拆開寫的三步：
1. **test-author subagent 先寫測試**（用 Codex，見下面「subagent 用誰」）。 給它：計畫的 Why、這個 slice 的 Outcome 與 Acceptance、公開介面、相關 skill 的規格。**不給**實作方式，也不讓它看實作。請它從規格和邊界情況寫測試（規則用「種子 + 動作 → 預期結果」），跑一次，交回測試和 RED 的輸出。邊界情況以 skill 寫到的為限；skill 沒定義的行為不要自己編成測試，列成問題交回。
2. **你檢查 Codex 寫的測試**：RED 的原因要對（功能還沒做，例如找不到函式、回傳不符，而不是語法、import 或設定錯）；再對照規格看有沒有漏掉重要的情況，或測了規格沒要求的細節（實作細節、skill 沒定義的行為、不可能發生的輸入）。有問題就連同理由退回 test-author 修，不要自己改。
3. **確認 RED 之後才開始實作**，寫到測試全過。實作者可以讀測試（測試就是規格），但**不准改測試**；覺得某個測試錯了，連同理由退回 test-author，還有爭議就通知 coordinator 問人。

PR 的「驗證」段要附 RED 的輸出（每個 slice 一段即可）。沒有 RED 證據的拆開寫 slice 不算完成。

**檢查（slice loop 第 4 步）** 一律跑 `pnpm check`，它依序是：
| 檢查 | 指令 | 管什麼 |
| --- | --- | --- |
| lint + format | `biome check .` | 程式風格、格式、`.skip`/`.only` |
| 死碼 | `knip` | 沒用到的檔案、export、依賴 |
| 型別 | `pnpm typecheck` | TypeScript strict |
| 測試 | `pnpm test` | 全部單元測試 |

格式不對就 `pnpm format` 修。knip 在這台 VM 會吃光記憶體，跑之前先 `export KNIP_DISABLE_RAW_TRANSFER=1`（不要寫進 repo）。

**驗收（slice loop 第 5 步）** 照 `/verification-evidence` 拿 Observed 的證據：API 用 `curl https://<route>-<wt>.<vm>.liaoann.net/...`（網址看 `wt-status`），網頁用 t3 preview 截圖。需要 dev server 時開在 tmux（`<wt>-api`），用完就關，VM 記憶體很少。

**Review（slice loop 第 6 步與最後）** 每個 slice 跑 `/review-change`，最後整個 branch 再跑一次（finished-feature 的 lenses）。照 `/review-change` 的規則選 lens（一般 slice 只要 Correctness + Test Quality；碰到合約、持久資料、共用模組才加 Design Fit、Simplicity；碰到驗證、外部輸入、秘密才加 Security），不要每個 slice 都開五個。每個 lens 的 reviewer 用 Codex（見下面「subagent 用誰」），合併重複、確認 Blocker、決定 Hardening 要不要修仍由你自己做。給 reviewer 的 plan 要附 ticket 原文，讓它也檢查：做多、做少、寫死的數字、碰了範圍外的檔案、改了合約、跟 skill 規格不符。有 Blocker 就修，重跑受影響的檢查和驗收。

**subagent 用誰**（2026-10-19 Ann）：你負責計畫、實作和所有決定。繁瑣但必須做的事交給 subagent：**寫測試、review、verifier 都用 Codex**。主要的 agent（你）一定是 Claude Opus 5.5；subagent 用 OpenAI，不同家的模型比較容易看到作者自己看不到的問題。Grok 暫停使用（額度用完，Ann 說先不用），等 Ann 說恢復再改回來。兩邊互相檢查：subagent 寫的測試你檢查，你寫的程式 subagent review，verifier 的結果你看過才開 PR。

**任務說明要短**：subagent 自己會讀 Dev VM 的 AGENTS.md（VM 規則與環境）和 [subagents.md](subagents.md)（角色能改什麼、這個 repo 在 VM 的坑、「不要鑽牛角尖」的標準、規格在哪、回報格式），任務說明不要再重寫這些。任務說明只寫：
- 第一行：「先讀 `<worktree>/.claude/skills/ticket-workflow/subagents.md`。你是 <角色>。」
- worktree 路徑和網址。
- 這次的範圍與輸入：test-author 給計畫的 Why、slice 的 Outcome 與 Acceptance、公開介面、要讀的 skill 段落；reviewer 給 diff 範圍（base commit）、lens 名稱、ticket 原文；verifier 給 ticket 原文。
- 這次特別要注意的事（如果有）。

你判斷 subagent 的意見時，也用 subagents.md「不要鑽牛角尖」的標準。

呼叫方式：
- 用 t3 的 `delegate_task`，不要用 harness 內建的 subagent。先呼叫 `orchestrator_capabilities` 確認 provider 和模型還在。`role` 填 `test`、`review` 或 `general`。
- `target`：
  - test-author、reviewer、verifier：`{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"medium"}}`。不要開 Fast，也就是不要設 `serviceTier`，Codex 額度會用得太快（2026-10-18 Ann）。
  - 不要用 Grok（暫停中）。
- **備援**：預定的那一家在 `orchestrator_capabilities` 裡有 constraints、沒有那個模型，或同一個任務實際跑了兩次都失敗（第二次要換新的 `clientRequestId`），就用同一份任務說明改用 `{"providerInstanceId":"claudeAgent","model":"claude-sonnet-5-5","options":{"effort":"high"}}`，`clientRequestId` 加上 `-sonnet`。碰到額度上限要通知 coordinator。PR 裡寫明哪些任務改用備援、為什麼。
- `isolation` 用預設的 `shared`：子任務直接在你的 worktree 裡跑，看得到還沒 commit 的改動。不要用 `worktree`，那會從上一個 commit 開新的 checkout，看不到你正在改的東西。子任務在跑的時候，你不要改檔案。
- 每個任務一個 `clientRequestId`（例如 `t09-s2-test-author-1`）。同一個 id 再送一次只會拿回原本的結果，不會重跑：呼叫沒有回應、不確定有沒有開成時才用同一個 id 重送；任務失敗要重跑或開新的一輪，就換新 id（例如 `-2`）。記下每個回傳的 `taskId`。
- 要等結果才能往下走時用 `mode:"wait"`、`timeoutMs: 1800000`。幾個 lens 可以各用 `mode:"async"` 同時開，等它們做完的通知。回傳 `waitTimedOut` 或收到通知後，用 `task_status` 拿最後的報告再往下走。
- 每個 subagent 結束後（包括失敗、被中斷），先 `git -C <path> status` 和 `git -C <path> diff` 確認它只動了允許的檔案；被中斷的 test-author 或 reviewer 可能留下沒還原的 mutant。動到不該動的就還原再往下走。
- 任務說明裡「允許的範圍」要寫完整，包括你這張 ticket 自己負責的測試檔（例如 `routes/*.test.ts`），不然 verifier 會把它們判成超出範圍。
- PR 的「驗證」和「Review」段寫明每個角色用了哪個 provider 和模型。

## 4. 獨立驗證
全部 slice 做完、整體 review 沒有 Blocker 後，開一個**全新的 verifier subagent**（用 Codex，見上面「subagent 用誰」）。作者自己的驗收不算數。給它 ticket 原文、worktree 路徑和網址，請它照 `/verification-evidence`：
1. 確認 `git -C <path> status` 乾淨（都已 commit）。
2. 在容器裡重裝依賴（`pnpm install --frozen-lockfile`），重跑 `pnpm check` 和 ticket 的每個驗證指令。
3. 自己起 dev server，照 ticket 的「功能驗證」在 worktree 網址上實際操作。
4. 每一項回報過或不過，附指令和輸出；做不到的標 inconclusive。
5. 關掉自己開的 dev server，用 `docker stats --no-stream` 確認容器回到閒置。

你看過 verifier 的報告再開 PR：每一項都要有指令和輸出，「過」要真的對應到 ticket 的驗證項目；看起來不對就開新的 verifier 重驗，不要自己改結論。

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
3. branch 跟最新的 `main` 沒有衝突。`main` 動過就 rebase 到 `origin/main`，重跑 verifier，再 push。例外：`main` 新增的 commit 只動 `docs/` 或 `.claude/`，而且 `git diff <rebase 前> <rebase 後> -- . ':!docs' ':!.claude'` 是空的，就不用重跑，在 PR 寫明。

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
| 介面跟說明書一致 | skill.md 從合約產生；抓出 skill.md 每個 curl 範例實際打一次，回應符合合約。改了參賽 agent 看得到的請求、回應、錯誤或 hint，同一張 ticket 就要更新 `apps/api/src/skill/template.md` 的說明和範例；範例裡的值要跟真實回應同格式（網址、時間格式、欄位都一樣），不要留下假網域或舊欄位 |
| 狀況處理 | `casino-api` skill「狀況處理」表每列一個測試 |
| 從頭到尾 | `pnpm e2e`，只用 curl + jq |
| 參賽 agent 好不好用 | `agent-playtest` skill |
