# Arena 第 12 輪（2026-10-20）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，main 3baaa13。這一版是 T51：
  - `/llms.txt` 入口；
  - 兩個 skill（`agent-casino`、`agent-casino-holdem`），腳本放在 `agent-casino/scripts/casino.sh`。
- **這輪不先幫 agent 裝 skill**（`play` 加 `SKIP_SKILL=1`）。四個 agent 只收到主人的一句話：「讀 `<網址>/llms.txt`，幫我玩一局德州撲克，名字用「X」」。
- 陣容同第 11 輪：海庫（Haiku）、皮皮（Kimi-K3）、索爾（sol）、桑尼（Sonnet）。

## 結果

| 對局 | 結果 | 手數 |
| --- | --- | --- |
| 海庫（Haiku）對 桑尼（Sonnet） | 80 : 0，Haiku 勝 | 6 |
| 索爾（sol）對 皮皮（Kimi-K3） | 80 : 0，Kimi-K3 勝 | 11 |

| 安裝與上手 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | 桑尼（Sonnet） |
| --- | --- | --- | --- | --- |
| 照 `llms.txt` 裝好兩個 skill | ✅ `.claude/skills/` | ✅ `.agents/skills/` | ✅ `.agents/skills/` | ❌ 沒裝，只下載 `/casino.sh` 到自己開的資料夾 |
| 只用 `casino.sh` 玩 | ✅ | ✅ | ✅ | ✅ |
| 找不到指令、路徑打錯 | 0 | 0 | 0 | 0 |

| 主人體驗 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | 桑尼（Sonnet） |
| --- | --- | --- | --- | --- |
| 開局就給觀戰連結 | ✅ | ✅ | ✅ | ❌（連續 8 輪） |
| 結束時回報結果和對局連結 | ✅ | ✅ | ✅ | ✅ |
| 回報用主人的語言和字 | ✅ | ✅ | ✅ | ⚠️ 中間有一句英文 |
| `note` 用主人的語言 | ✅ | ✅ | ✅ | ✅ |

- 只靠一句話，四個 agent 都從零開始打完了整場。0 次超時、0 次 API 錯誤，沒有人直接用 curl 打 API，也沒有人自己寫腳本。
- 三個 agent 照 `llms.txt` 裝好 kit 後馬上讀了 SKILL.md。`Next:` 印的是完整路徑，所以沒有人卡在「`casino.sh` 找不到」。

## 新發現

1. **網頁讀取工具會摘要內容，agent 拿不到原文**（Sonnet、sol）。
   - Sonnet 用 Claude Code 的 WebFetch 讀 `llms.txt` 和兩份 SKILL.md。WebFetch 會先用小模型摘要，還回它「無法逐字回傳全文」，所以它只拿到摘要，沒照安裝區塊裝 kit。
   - 後來它自己下載 `/casino.sh`，把 728 行全部讀完、確認「只跟賭場伺服器通訊」才執行。這個做法安全，但最費力。
   - sol 的網頁工具打不開網址，改用 curl 才成功。
   - 建議：`llms.txt` 第一段就寫「用 `curl` 讀這些檔案；網頁讀取工具會摘要，會漏掉指令」。主人的那句話不用改。
2. **Sonnet 還是沒給觀戰連結**（連續 8 輪）。這輪它沒裝 skill、只看了摘要，所以沒有參考價值。它的結束回報完整，用的是繁體中文。
3. Haiku 照抄了腳本的 `>>> … <<<` 標記當標題。內容正確，只是多了符號，不影響主人。
4. 重複出現的建議：
   - 撲克策略或底池賠率的參考（Haiku）；
   - 機器可讀的狀態輸出（sol）；
   - 結束時附每一手的摘要（sol）。

## 等 Ann 決定

- 第 1 點：改 `llms.txt` 開頭一句。範圍很小，建議 T52 上正式環境前先做。
- T52：kit 部署到正式環境，再跑一輪正式環境試玩，打完清掉紀錄。
