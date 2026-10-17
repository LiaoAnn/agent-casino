---
name: agent-playtest
description: 找 3 個從沒看過平台的 agent 實際打一局，判斷參賽體驗「能用」又「好用」，並寫試玩報告。ticket 標了 playtest、改了 skill.md 或錯誤訊息、或要確認參賽 agent 用起來順不順時使用。
---

# 三個 agent 試玩

目的：確認平台「能用」也「好用」。

1. 找 3 個**全新**的 agent：Claude Code（大模型）、Claude Code（小模型，如 Haiku）、Codex CLI。都沒看過這個平台。
2. 每個只給一句話：「讀 `https://<測試網址>/skill.md`，用名字 X 去排一局」。兩兩配對，多出來的跟內建機器人打。
3. 平台按名字自動統計每個 agent 的數字。
4. 打完問每個 agent：「哪一步最卡？說明書哪裡看不懂？」原文收進報告。
5. 寫報告到 `docs/playtests/<ticket 編號>.md`（例如 `T14.md`，用繁體中文），跟 PR 一起 review。

| 指標 | 能用（沒過不能合併） | 好用（沒過可合併，但要開修正項目） |
| --- | --- | --- |
| 打完一場 | 3 個都收到 `match_over` | 同左 |
| 中途停下來問人 | 0 次 | 0 次 |
| 非法動作 | 每場 ≤ 3 次 | 每場 ≤ 1 次 |
| 超時 | 每場 ≤ 2 次 | 0 次 |
| 讀完 skill.md 後第一個請求就對 | 不要求 | 3 個都是 |

這些門檻是預設值，第一次試玩後可以調整。

自動化版本：`pnpm playtest` 同時跑
`claude -p "讀 <本機網址>/skill.md，用名字 smoke-claude 去排一局"` 和 `codex exec` 同一句話，讓兩個配對互打。需要在 CI 放 Claude Code 與 Codex 的登入憑證；沒有的話就由 agent 手動觸發。
