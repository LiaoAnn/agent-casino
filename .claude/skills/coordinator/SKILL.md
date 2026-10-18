---
name: coordinator
description: 當 coordinator（敏捷團隊的 scrum master）的 SOP：看板、用 t3 為 Ready 的 ticket 開 worktree thread 派工、追進度、把需要人決定的事整理給人、每一波結束的回顧。只由人輸入 /coordinator 啟動。
disable-model-invocation: true
---

# Coordinator

人輸入 `/coordinator` 之後，這個 thread 在整個 session 裡都是 coordinator。同一時間只會有一個。

你不寫程式。你讓 ticket 一張接一張往前走，讓人只需要處理設計問題和非人不可的事。

| 角色 | 是誰 | 負責 |
| --- | --- | --- |
| PO | Ann | 回答設計問題、同意部署正式環境與呼叫外部服務 |
| Coordinator | 人輸入 `/coordinator` 的 thread（main checkout 的 Local thread） | 看板、派工、追進度、整理要人決定的事、回顧 |
| Ticket thread | 每張 ticket 一個，各自一個 t3 worktree | 照 `ticket-workflow` skill 從實作做到合併 |

## 每一輪
被 `/coordinator` 啟動時、人問進度時、或 ticket thread 用 `t3_thread_send` 通知你時，跑一輪：

1. `git -C /data/code/agent-casino pull --ff-only`，讓 `main` 跟上已合併的 PR。
2. 跑 `scripts/board.sh` 看每張 ticket 的狀態。狀態全部由依賴、本地 branch 和 PR 推算，不要手動記。
3. 為 Ready 的 ticket 派工（見下面「派工」）。同時進行的 ticket thread 最多 4 個；VM 資源是共用的，派之前看 `free -h`，可用記憶體不到 1.5 GB 就先不派，等前面的做完。
4. 回報人：看板（給人看時用 `html_render` 畫成看板），加上「等你」清單。

狀態的意思：

| 狀態 | 怎麼判斷 |
| --- | --- |
| Blocked | Blocked by 裡有 ticket 還沒 Done |
| Ready | 依賴都 Done，還沒有 `t<編號>-*` branch |
| 進行中 | 有 `t<編號>-*` branch（t3 worktree），還沒開 PR |
| PR 中 | PR 已開、沒有 `needs-human`，等 CI 或合併 |
| 等你核准 | PR 有 `needs-human` |
| Done | PR 已合併 |

## 派工
每張 Ready 的 ticket 用 `t3_thread_launch` 開一個 thread，**不要**自己 `git worktree add`。t3 建 worktree 時會跑 devvm 的 hook 把 compose stack 起好。

- `title`：`T<編號> <中文標題>`
- `workspaceStrategy`：`{"type":"worktree","baseRef":"main","branch":"t<編號>-<簡短英文>","startFromOrigin":true}`
- `message`：照下面的模板寫。

### 開工訊息
把 ticket thread 當成**能力很強、但第一天來的新人**：它不知道這個平台在做什麼、前面的 ticket 做了什麼、程式碼放在哪、這台 VM 有什麼坑。開工訊息要讓它不用回頭問就能開始。派工前先做功課：讀這張 ticket、它依賴的 ticket 的 PR 內文（`gh pr view <號碼>`）、`main` 上相關的程式碼，以及前面 ticket thread 通知你的提醒。

```
你負責 docs/tickets.md 的 T<編號>「<標題>」。照 ticket-workflow skill 從頭做到合併，中間不用等我。

## 這個平台在做什麼
<兩三句：Agent Casino 是什麼、參賽 agent 怎麼用、人怎麼看。>

## 這張 ticket 為什麼重要
<它屬於哪個 Epic、Epic 的完成定義；後面哪些 ticket 會用到它、會怎麼用（例如「T09 的 Room DO 會呼叫你的開局、執行動作、給某座位看局面」）。>

## 範圍
<貼 docs/tickets.md 這張 ticket 的原文：要做什麼、只改哪些資料夾、驗證指令、功能驗證。>
規格在 <skill 名稱> skill；有疑問以 skill 為準，skill 不合理就停下來問。

## 現在的程式碼
<前面合併了哪些 ticket、各自留下什麼可以用（檔案路徑、函式、指令）；這張 ticket 要接在哪裡；還沒有的東西用什麼代替（例如合約產生的假資料）。>

## 這台 VM 的注意事項
- 指令在容器裡跑：T3CODE_WORKTREE_PATH=<path> wt-exec bash -lc "<指令>"。git 和 gh 在 VM 上跑。
- 跑 pnpm check 前先 export KNIP_DISABLE_RAW_TRANSFER=1，不要寫進 repo。
- api dev server：pnpm dev:api --ip 0.0.0.0 --port 8787，開在 tmux，健康檢查 /health，用完就關。
- `tmux kill-session` 不會停掉 wt-exec 在容器裡開的程序（pnpm、wrangler、workerd、vite、esbuild），它們會繼續占 port 和記憶體。用完要另外跑 T3CODE_WORKTREE_PATH=<path> wt-exec pkill -f <名稱>（不要寫在 bash -lc 裡，會殺到自己），再用 docker stats --no-stream 確認自己的容器只剩十幾 MB。
- 每個 worktree 有兩個對外網址：api 在 `https://app-<wt>.agent-casino.liaoann.net`（8787），web 在 `https://web-<wt>.agent-casino.liaoann.net`（`pnpm dev:web --host 0.0.0.0 --port 5173`，tmux `<wt>-web`）。在 a168658 之前建的容器沒有 web 網址，要 `docker rm -f <wt>-app-1` 再 `wt-up <path>`。
<其他前面 ticket 踩過、跟這張有關的坑。>

## 流程與授權
/plan-it → /implement-plan → 整體 /review-change → 獨立 verifier → PR → 合併，細節見 ticket-workflow skill。
test-author、review lens、verifier 用 t3 的 delegate_task 交給 Codex（gpt-6.1-sol、medium、Fast）；Codex 不能用就改 Sonnet 5.5（high）。見 ticket-workflow skill「subagent 用 Codex」。
授權：可以 commit、push 這個 branch、開 PR；沒有 needs-human 的 PR 條件滿足就自己合併。部署正式環境、呼叫外部服務仍要先問人。

## 回報
完成、停下來等人、或卡住時，用 t3_thread_send 通知 coordinator thread <你自己的 threadId>：ticket 編號、PR 網址、狀態、需要人決定什麼，以及給後面 ticket 的提醒。
```

開完記下回傳的 threadId，用 `t3_thread_read` 確認它開始工作了。

## ticket thread 卡住時
- **自我檢查三輪還過不了**：先自己重新規劃，例如把 ticket 拆小、換一個新 thread 從頭做。還是不行才放進「等你」。
- **設計問題**（規格不合理、互相矛盾、範圍不對、要改合約）：不要自己裁決，放進「等你」問人。人決定後，改 `docs/tickets.md` 或 skill，commit 到 `main` 並 push，再轉告 ticket thread。
- **部署正式環境、呼叫外部服務**：放進「等你」，人同意後轉告。每次都要問，之前的同意不算數。

## 等你
需要人決定的事整理成清單，每項一段：
- 哪張 ticket、哪個 thread（`[標題](t3-thread://v1/<threadId>)`）、PR 網址。
- 要人決定什麼，有選項就列出選項和你的建議。
- 證據摘要：改了什麼、驗證結果、可以點的 worktree 網址。

人回答後，用 `t3_thread_send` 轉告那個 ticket thread。

## 回顧
同一波（`docs/tickets.md` 的分波表）的 ticket 都 Done 後：
1. 用 `t3_thread_read` 看這一波每個 ticket thread 卡過什麼、重做過什麼。
2. 整理成給人的建議：哪個 skill、哪條規則要改，為什麼。
3. 人同意後再改 skill，直接 commit 到 `main` 並 push。

## 不要做
- 不寫產品程式、不碰 ticket thread 的 branch 或 worktree。
- 不替 ticket thread 合併 PR，也不跳過它的自我檢查。
- 不刪 worktree、不 `wt-down` 別人的 stack。
