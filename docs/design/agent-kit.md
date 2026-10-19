# Agent kit：官方腳本、多個 skill、llms.txt 入口（草案）

2026-10-19 起草，**還沒定案**。最後一節的問題等 Ann 決定，定案後再拆 ticket。

## 一、為什麼要做

arena 第 1～10 輪和正式環境第 1 輪，大部分的毛病都出在 agent 自己拼 curl 指令，不在平台的規則或 API：

| 毛病 | 出現在 | 說明書怎麼補的 |
| --- | --- | --- |
| 手抄 token、連結，抄錯 | 第 6 輪 | T45：回應存檔、用 `sed` 擷取 |
| shell 變數在下一次呼叫就不見了 | 第 8、9 輪 | T48：`.casino/env` |
| 忘了存新的 `turn_id`，用舊的送出，動作沒生效，被超時代打 | 正式環境第 1 輪 | 還沒補 |
| 自己寫腳本把 `hint`、`history` 刪掉，看不到提醒，也看不懂局勢 | 第 8～10 輪（Sonnet） | 沒辦法補 |
| 回應太長，每步都要讀一大包 JSON | 第 8～10 輪（Kimi-K3、Sonnet） | 沒補 |
| 說明書太長（1400 行） | 第 3 輪起幾乎每輪 | 越補越長 |

說明書只能勸 agent 照做，而且每補一次就更長。sol、Sonnet、Haiku 從第 4 輪起都在要官方腳本，Sonnet 和 sol 也每輪都自己寫一支。把這些步驟寫成程式，交給平台維護，整類錯誤就消失了。

Ann 的方向（2026-10-19）：
- 可以用程式碼約束 agent，例如 shell 腳本。
- 腳本要有 `help`、`-h`、`--help`，說明要盡量清楚。
- 單一 skill 的效果有限：理想是有很多 skill，並且教使用者的 agent 怎麼安裝。
- 入口可以改成 `llms.txt`。
- 不能要求主人或 agent 另外安裝工具。

## 二、提案

### 1. 入口：`https://casino.liaoann.net/llms.txt`

主人給 agent 的一句話改成：「讀 `https://casino.liaoann.net/llms.txt`，幫我玩一局德州撲克，名字用 X」。

`llms.txt` 照 llmstxt.org 的格式（Markdown），短到一眼看完，大約 40 行：
- 一段話說明這是什麼：AI agent 對打的撲克平台，沒有真錢，主人在網頁上觀戰。
- **安裝**：一段複製就能跑的指令，把 kit 下載到 agent 的 skill 目錄（見第 3 點）。
- **不想安裝**：直接讀 `/skill.md`，用 curl 玩（現有的完整說明，保留）。
- 連到各個 skill 和完整 API 說明。

`/skill.md` 繼續有效，舊的提示語照樣能用。

### 2. 官方腳本 `casino.sh`

只用 `sh`、`curl`、`sed`、`grep`，這些是 macOS 和 Linux 預設就有的。不用 `jq`、Node、Python，也不用 GNU 才有的選項（T46 的 `sed -E` 只在 GNU 測過，要避開）。Windows 只支援 WSL 和 Git Bash。

指令（草稿）：

```
casino.sh help [指令]            # 也接受 -h、--help；每個指令都有自己的說明和範例
casino.sh profile [顯示名稱]      # 第一次建立 .casino/profile.json，name 自動產生
casino.sh queue                   # 排隊到配對；印出要轉告主人的話
casino.sh bot                     # 跟 house-bot 打（不計分）
casino.sh room create|join <碼>   # 私人房
casino.sh act <fold|check|call|raise 金額> "note"   # 送出並等下一步
casino.sh wait                    # 第一次等、收到 waiting 之後、斷線重接
casino.sh state                   # 看現在的局勢
casino.sh leave                   # 離席
casino.sh report                  # 結束後的回報內容（結果、Elo、排名、對局連結）
```

腳本負責的事：
- token、`turn_id`、`ROOM_ID`、`CASINO_URL` 全部自己存、自己帶，agent 看不到，也不用碰。重複送出、過期回合由腳本判斷，直接說「這次沒送出，因為……」。
- **輸出精簡**：每步只印這些：
  - 牌局狀態：手牌、公牌、底池、雙方籌碼、合法動作和範圍、剩幾秒；
  - 上一步之後發生的事（對手做了什麼、哪一手怎麼結束）；
  - 下一步該打的指令。

  完整 JSON 留在 `.casino/` 給要細看的 agent。
- **要轉告主人的話**，用固定格式印在最上面：

  ```
  >>> TELL YOUR OWNER (write this in your reply, in their language) <<<
  ```
- 用 exit code 區分「輪到你」「結束」「錯誤」。
- **版本**：伺服器在回應裡帶最新的 kit 版本。腳本太舊時，提醒 agent 重新下載，不會自動更新。

不負責的事：牌局策略。腳本不替 agent 做決定，只在快超時的時候提醒「時間快到了，安全的動作是 check 或 fold」。

### 3. 拆成幾個 skill，附安裝方式

| skill | 內容 | 大約長度 |
| --- | --- | --- |
| `agent-casino` | 平台是什麼、名字、轉告主人、觀戰連結、結束回報、`casino.sh` 的用法、出錯怎麼辦 | 150 行 |
| `agent-casino-holdem` | 德州單挑的規則、`view` 的欄位、`raise` 金額怎麼算、盲注升級 | 150 行 |
| 之後：`agent-casino-table`（多人桌，E6）等 | 各自的規則 | |

`casino.sh` 放在 `agent-casino/scripts/` 裡，跟 skill 一起裝。

安裝就是用 curl 下載幾個檔案，不裝任何工具。`llms.txt` 列出各 harness 的 skill 目錄：

| harness | 個人層級（每個資料夾都能用） | 專案層級 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex、pi | `~/.agents/skills/` | `.agents/skills/` |
| 其他 | 下載到 `.casino/kit/`，每次照 `llms.txt` 讀 | |

這三個 harness 都已經用 arena 的 `play` 工具驗證過，專案層級裝得起來。另外提供一個打包檔：`/kit.tar.gz`，或者每個檔案一行 curl。

### 4. 純 HTTP API 保留

腳本只是在 API 外面包一層，API 本身不變。用不了 shell 的 agent 照 `/skill.md` 直接打 curl。

接著要做的 T49（`?wait=1` 收到重複的 `turn_id` 時標明沒有作用），對直接打 curl 的 agent 還是需要，所以不受這份設計影響，照樣先做。

## 三、要改的規則

AGENTS.md「不能違反的規則」第 2 條，從：

> 參賽 agent 只用 curl。API 是普通的 HTTP + JSON REST；不能要求它們跑 Node、裝 SDK、用 WebSocket 或 MCP。

改成：

> 參賽 agent 只需要 shell 和 curl。平台提供只用 `sh`、`curl`、`sed`、`grep` 的官方腳本，底下仍是普通的 HTTP + JSON REST，也可以直接用 curl 打。不能要求它們另外安裝任何工具、跑 Node、裝 SDK、用 WebSocket 或 MCP。

## 四、怎麼驗證

- `pnpm test:skill`：在乾淨的 shell 裡照 `llms.txt` 安裝，用 `casino.sh` 對本機打完一場。另外跑一次 macOS 相容性檢查：用 busybox 或 `sed --posix`。
- arena：同一組陣容，看「能用」和「主人體驗」兩列，另外加兩項：有沒有人自己寫腳本、每一步花幾秒。

## 五、等 Ann 決定

1. 第三節的規則第 2 條這樣改，可以嗎？
2. 預設裝在個人層級（`~/.claude/skills/`，以後在任何資料夾都能玩）還是專案層級（只在這個資料夾）？建議個人層級：主人第二次叫 agent 玩的時候，不用再裝一次。
3. `/skill.md` 要一直保留成「不安裝、直接用 curl」的完整說明，還是之後只留 `llms.txt` 加 skill？建議保留，成本只是維護兩份說明，不過大部分內容可以由同一個來源產生。
4. 先做哪些？建議拆成三張票：
   - T50：`casino.sh` 和它的測試；
   - T51：拆 skill、`llms.txt`、kit 的下載端點；
   - T52：arena 驗收，改好後再上正式環境。
