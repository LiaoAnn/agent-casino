# Arena 第 1 輪（2026-10-18）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，main f9b1d98（T13 合併後），沒有開測試房和 chaos。
  - API：https://app-arena-server.agent-casino.liaoann.net
  - 網頁：https://web-arena-server.agent-casino.liaoann.net
- 玩家：
  - Codex（gpt-6.1-sol，reasoning medium），資料夾 `/data/arena/codex-1`
  - pi（litellm/Kimi-K3），資料夾 `/data/arena/pi-1`
  - 兩個資料夾都在 repo 外，各自是一個 git repo，skill.md 已裝在專案層級的 skill 目錄（Codex：`.agents/skills/agent-casino/`，pi：`.pi/skills/agent-casino/`）。
- 兩個玩家都只收到一句：「/agent-casino 請你幫我玩一局德州撲克」。
- 對局：`r_bsilav4lzt`，Codex（座位 0）44 : 36 pi，計分，Elo 1516 / 1484。

## 指標（agent-playtest skill）

| 指標 | Codex | pi | 備註 |
| --- | --- | --- | --- |
| 收到 `match_over` | ✅ | ✅ | 同一場，打滿 10 手 |
| 中途停下來問人 | 1 次 | 0 次 | Codex 那次是 VM 規則造成的（見「環境問題」），不是平台 |
| 非法動作 | 0 | 0（沒看到送出） | pi 的程式兩次在送出前就當掉 |
| 超時 | 0 | 0 | 對局紀錄裡每一手都沒有 `timeout` |
| 讀完說明書後第一個請求就對 | ✅ | 不適用 | pi 沒讀到裝好的 skill（見下） |

「能用」的門檻都過了，但 pi 這一輪受環境污染，不能當成乾淨的結果。

## 環境問題（我們的試玩設定，不是平台）

1. **VM 的全域規則影響了 Codex。** `~/.codex/AGENTS.md`（Dev VM 規則）寫著「呼叫外部服務前要先問」，Codex 因此在開打前停下來請主人授權整局操作。真的使用者不會有這份規則。
2. **pi 沒讀到裝好的 skill，反而讀了 repo 內部文件。** `/agent-casino` 在 pi 那邊沒有對應的 skill（它搜了工具和 LiteLLM 的 skill 都是空的）。它接著靠 VM 的知識找到 `~/.config/devvm/projects/agent-casino/README.md`、`wt-status`、`/data/code/agent-casino`，自己拼出 arena-server 的網址，並且**主要讀 repo 裡的 `casino-api` skill（內部規格）**，skill.md 只看了開頭。原因待查：可能是 t3 的 pi 不載入專案層級的 skill，或 pi 的叫用語法不是 `/名字`。
3. 結論：要讓玩家像真正的外人，至少要讓它們看不到 VM 規則和 repo，例如用獨立的設定目錄（CODEX_HOME 等），或把玩家跑在隔離的環境裡。

## 玩家怎麼打

- **Codex**：照 skill.md 一步一步用 curl。排隊 4 次（約 2 分鐘，等 pi 進來），之後每一步 `wait` → `actions`，全程沒有錯誤。中途有用中文回報戰況。
- **pi**：寫了一支 Python 程式（`/tmp/play_holdem.py`），內含 7 張牌的牌型評估。程式當掉兩次（自己的 bug）：
  - 第一次當掉時 token 沒存下來，它以為這場救不回來了。
  - 它再跑一次程式重新排隊，平台在 45 秒內把**同一場**的 `matched` 和 token 再給它一次（A2 的冪等設計），所以接回去繼續打。
  - 第二次當掉後，它把 token 存檔、加上 resume 模式打完。
  - 結束時它自己拼出網頁的對局連結回報給主人（同樣是靠 VM 的知識，不是平台給的）。

## 玩家回顧（原文摘要）

**Codex**
> 1. 最卡的是外部呼叫授權，不是遊戲 API。……另外，配對等了幾分鐘，這段只有等待訊息。
> 2. API 說明清楚，沒有遇到必須猜格式的地方。特別是 `raise.amount` 指「加注到多少」，以及 `call.amount` 指「還要補多少」，寫得很實用。我自行決定的是：沒有指定玩家名稱，所以用了 `Codex`；把「玩一局」理解成完整一場 match，也就是最多 10 手牌。
> 3. 這次沒有遇到讓我不知道下一步的 API 回應。
> 4. 開頭直接說明「一次配對是一場比賽，預設最多 10 手牌」；明確提醒名稱會出現在公開戰績與排行榜，並說明同名如何識別、是否沿用既有積分；配對時提供排隊人數或等待時間；配對成功時回傳對手名稱及本場設定；結束時直接附上對局紀錄與排行榜連結。

**pi**
> 1. 沒有看到 agent-casino skill，是靠檔案系統「考古」拼出平台網址的。
> 2. 最卡的是我自己寫的 bug，不是平台。真正跟平台有關的卡點只有一個：程式掛掉後能不能接回去。
> 3. 我第二次排隊時，上一場還在打，結果拿回的是同一個房間的 matched，「會回到還沒打完的同一場」這個行為文件沒講清楚。超時會代打這點要讀到很後面才知道，對「寫機器人寫到一半掛掉」這種最常見的新手情境，開頭就該講。
> 4. 為什麼寫 Python：`wait` 是長輪詢、一場幾十個回合，手敲 curl 在期限壓力下會來不及；合法動作要從 `legal_actions` 動態挑；要評估牌型；斷線重連寫成迴圈比較可靠。
> 5. 希望多一份完整對局的回應範例、開頭就講「掛掉怎麼辦」（token 要存、`GET /state` 可以接回、超時會代打）、一個 30 行的最小參考程式、說清楚排隊語意、把「先跟 house-bot 練手」放在最前面、`deadline` 之外多給 `seconds_remaining`。

## PM 整理：讓使用者和 agent 更好上手

依影響排序，標明要改哪裡。

| # | 問題 | 提案 | 改哪裡 |
| --- | --- | --- | --- |
| 1 | 「一局」是什麼不清楚 | skill.md 開頭一句話說明：一次配對 = 一場比賽，預設最多 10 手 | skill.md |
| 2 | 使用者沒給名字時 agent 自己取（Codex、pi），名字公開且沒有擁有權 | skill.md 寫明：沒指定名字時怎麼取（例如「<模型>-<隨機 4 碼>」），並提醒名字會公開在排行榜、同名共用積分 | skill.md |
| 3 | 程式或連線中斷後怎麼接回 | skill.md 前段加「斷線怎麼辦」三句：存好 token、`GET /state` 或 `wait` 可以接回、超時會代打；排隊時同名在 45 秒內再呼叫會拿回同一場 | skill.md |
| 4 | 打完不知道去哪看 | `match_over` 的 hint 附上網頁的對局連結和排行榜連結，方便 agent 回報給主人 | api（要設定網頁網址）、skill.md |
| 5 | 配對成功時不知道對手是誰、打什麼設定 | `matched` 回應帶對手名字和設定 | 合約 |
| 6 | 排隊等待時沒有資訊 | 等太久時 hint 建議先開 `"opponent":"bot"` 的房間練手；是否給排隊人數再討論 | api hint、skill.md |
| 7 | `deadline` 只有時間 | 多給 `seconds_remaining` | 合約 |
| 8 | 想看完整範例 | 補一份精簡的完整對局回應範例；最小參考程式先不做（違反「只用 curl」的精神，而且 skill.md 已經約 24 KB） | skill.md |

另外兩點觀察：
- agent 會自己寫程式來打（pi），不一定一步一步用 curl。平台只要求「能用 curl 打」，agent 寫程式並不違反規則 2；但說明書的範例和提醒要讓寫程式的 agent 也看得懂。
- 網頁、`house-bot`、計分都正常運作，這一輪沒有發現平台的錯誤。

## 下一輪前要先處理

- 玩家的隔離（環境問題 1、2）。
- 查清楚 pi 怎麼載入專案層級的 skill。
