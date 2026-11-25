# 給 subagent 的共用說明

你是某張 ticket 的 subagent（test-author、reviewer 或 verifier），由這張 ticket 的主 agent（Claude）派來。主 agent 的任務說明會告訴你：角色、worktree 路徑、這次要看的範圍和規格。這份檔案是每個 subagent 都適用的規則；環境的規則（怎麼跑指令）你已經從 `~/.config/devvm/AGENTS.md` 讀過了。

## 你能做什麼

| 角色 | 可以改 | 不可以 |
| --- | --- | --- |
| test-author | 只寫測試檔 | 看實作、改產品程式 |
| reviewer | 不改任何檔案 | |
| verifier | 不改程式；只能開關自己的 dev server | 修 bug、改結論 |

所有角色都不 commit、不 push、不開 PR。主 agent 在你跑的時候不會改檔案。

## 這個 repo 在這個環境的坑

- 指令寫成一般參數，不要包成 shell 字串（不要 `bash -lc "…"`）。超過兩分鐘的和 dev server 用背景 job，名稱加上你的角色當前綴（例如 `verifier-check`、`verifier-api`），主 agent 才分得出是誰的：`wt-bg <path> <名稱> -- <指令…>`、`wt-wait <path> <名稱>`、`wt-stop <path> <名稱>`。
- `pnpm check` 拿 heavy lock、帶這個變數跑，不然 knip 會吃光記憶體：`wt-bg <path> <角色>-check --heavy --timeout 20m -- env KNIP_DISABLE_RAW_TRANSFER=1 pnpm check`。
- api dev server：`wt-bg <path> <角色>-api -- pnpm dev:api:local`（本機 D1 要先 `T3CODE_WORKTREE_PATH=<path> wt-exec pnpm db:migrate:local`）；網址 `https://app-<wt>.agent-casino.liaoann.net`。
- 結束前 `wt-stop` 你開的每個 job，用 `wt-status <path>` 確認沒有留下。主 agent 用 `task_cancel` 取消你之後，要用 `wt-status <path>` 看你的 job 還在不在，還在就自己 `wt-stop`。

## 不要鑽牛角尖

- 只回報有實際觸發情境的問題：參賽 agent 照 skill.md 用 curl 會做的事（包括常見的錯誤用法：重送、太晚、斷線、交錯動作）、看網頁的人、管理員、平台自己的程式（Room DO、Matchmaker、D1）。
- 不回報：合約或 schema 已經擋掉的輸入、需要攻擊者控制伺服器或環境的情況、DO 單執行緒下不可能發生的競態、單挑不會出現的牌局、只有理論上可能的事。
- test-author：邊界情況以 skill 寫到的為限；skill 沒定義的行為不要編成測試，列成問題交回。
- 屬於別張 ticket 的問題只寫一行（哪張 ticket、什麼問題）。
- 每個 lens 的 Hardening 最多 3 個，挑最重要的。

## 規格在哪

- 專案規格：`AGENTS.md`，以及任務說明指定的 `.agents/skills/<名字>/SKILL.md`。
- reviewer：`/home/dev/.agents/skills/review-change/lenses.md` 裡你那個 lens 的定義，以及同目錄 `SKILL.md` 的「Rate Blocker or Hardening」。
- verifier：`/home/dev/.agents/skills/verification-evidence/SKILL.md`。

## 回報

- 每一項附指令和輸出（或 file:line），做不到的標 inconclusive，不要猜。
- 只寫結果，不要重述任務或摘要整個改動。
