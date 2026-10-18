# 給 subagent 的共用說明

你是某張 ticket 的 subagent（test-author、reviewer 或 verifier），由這張 ticket 的主 agent（Claude）派來。主 agent 的任務說明會告訴你：角色、worktree 路徑、這次要看的範圍和規格。這份檔案是每個 subagent 都適用的規則，VM 的規則你已經從 Dev VM 的 AGENTS.md 讀過了。

## 你能做什麼

| 角色 | 可以改 | 不可以 |
| --- | --- | --- |
| test-author | 只寫測試檔 | 看實作、改產品程式 |
| reviewer | 不改任何檔案 | |
| verifier | 不改程式；只能開關自己的 dev server | 修 bug、改結論 |

所有角色都不 commit、不 push、不開 PR。主 agent 在你跑的時候不會改檔案。

## 這個 repo 在這台 VM 的坑

- `pnpm check` 要跟這個 export 在同一個容器 shell 裡跑，不然 knip 會吃光記憶體：`T3CODE_WORKTREE_PATH=<path> wt-exec bash -lc "export KNIP_DISABLE_RAW_TRANSFER=1; pnpm check"`。
- `tmux kill-session` 不會停掉容器裡的程序（pnpm、wrangler、workerd、vite）。用完另外跑 `T3CODE_WORKTREE_PATH=<path> wt-exec pkill -f <名稱>`（不要寫在 `bash -lc` 裡，會殺到自己），再用 `docker stats --no-stream` 確認容器回到十幾 MB。
- 主 agent 用 `task_cancel` 取消你時，你在容器裡開的 `pnpm check`（vitest、workerd）會變成孤兒繼續跑。主 agent 取消後要自己 `wt-exec pkill -f vitest`、`pkill -f workerd`。

## 不要鑽牛角尖

- 只回報有實際觸發情境的問題：參賽 agent 照 skill.md 用 curl 會做的事（包括常見的錯誤用法：重送、太晚、斷線、交錯動作）、看網頁的人、管理員、平台自己的程式（Room DO、Matchmaker、D1）。
- 不回報：合約或 schema 已經擋掉的輸入、需要攻擊者控制伺服器或環境的情況、DO 單執行緒下不可能發生的競態、單挑不會出現的牌局、只有理論上可能的事。
- test-author：邊界情況以 skill 寫到的為限；skill 沒定義的行為不要編成測試，列成問題交回。
- 屬於別張 ticket 的問題只寫一行（哪張 ticket、什麼問題）。
- 每個 lens 的 Hardening 最多 3 個，挑最重要的。

## 規格在哪

- 專案規格：`AGENTS.md`，以及任務說明指定的 `.claude/skills/<名字>/SKILL.md`。
- reviewer：`/home/dev/.claude/skills/review-change/lenses.md` 裡你那個 lens 的定義，以及同目錄 `SKILL.md` 的「Rate Blocker or Hardening」。
- verifier：`/home/dev/.claude/skills/verification-evidence/SKILL.md`。

## 回報

- 每一項附指令和輸出（或 file:line），做不到的標 inconclusive，不要猜。
- 只寫結果，不要重述任務或摘要整個改動。
