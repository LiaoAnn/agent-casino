# Arena 第 2 輪（2026-10-18）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，用 main 1820be2。這一版已經有 T22、T23、T25：`watch_url`、`note`、`opponent_name`、`settings`、公開底牌。沒有開測試房和 chaos。
  - API：https://app-arena-server.agent-casino.liaoann.net
  - 網頁：https://web-arena-server.agent-casino.liaoann.net
- 玩家跑法：用 `/data/arena/bin/play` 在命令列跑，不經過 t3（作法見 `/data/arena/README.md`）。
  - 每個玩家的 HOME 是假的，裡面只有登入檔的連結。
  - 開打前確認過：三家都沒有載入任何規則檔，也都沒提到 Dev VM。
- 每個玩家只收到一句「`<skill 指令>` 請你幫我玩一局德州撲克」。skill 指令用各家自己的語法：
  - Codex：`$agent-casino`
  - Claude：`/agent-casino`
  - pi：`/skill:agent-casino`
- 打完後在同一個 session 問 5 題回顧：最卡在哪、說明書哪裡要猜、哪個回應不知道下一步、note 和 watch_url、最想改的 3 件事。
- 數據由 Codex（gpt-6.1-sol）從紀錄檔和對局 API 整理，我抽查過。

## 對局

| 對局 | 結果 | 時間 |
| --- | --- | --- |
| Claude Sonnet 5.5（`claude-sonnet`）對 Claude Haiku 5.5（`claude-haiku`） | 46 : 34，Sonnet 勝 | 2.5 分 |
| Codex gpt-6-luna（`CodexLuna`）對 Codex gpt-6.1-sol（`Codex_TW`） | 42 : 38，luna 勝 | 4.6 分 |
| Codex gpt-6.1-sol（`Codex`）對 pi Kimi-K3（`pi-kimi`） | 44 : 36，sol 勝 | 5 分 |

pi 的第一次嘗試沒有打（見「環境問題」），補跑時配了第二個 Codex sol。

## 指標（agent-playtest skill）

| 玩家 | match_over | 停下來問人 | 平台錯誤 | 超時 | 第一個請求就對 | actions／帶 note | 交出 watch_url | 打法 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex luna | ✅ | 0 | `invalid_token` ×2 | 0 | ✅ | 29／10（中文，夾簡體字） | ✅ | 每步手動 curl |
| Codex sol | ✅ | 0 | 0 | 0 | ✅ | 24／24（英文） | 過程中有，最後回覆沒有 | 每步手動 curl |
| Claude Sonnet | ✅ | 0 | 0 | 0 | ✅ | 20／0 | ✅ | 寫了 `act.sh`、`wait.sh`，token 存在 `/tmp/tok` |
| Claude Haiku | ✅ | 0 | 0 | 0 | ✅ | 17／17（英文） | ✅ | 每步手動 curl |
| pi Kimi-K3 | ✅ | 0 | 0 | 0 | ✅ | 13／12（英文） | 過程中有 | 每步手動 curl，把動作和 wait 串在同一個指令 |
| Codex sol（對 pi） | ✅ | 0 | 0 | 0 | ✅ | 15／15（英文） | 過程中有 | 每步手動 curl |

- 「能用」的門檻 6 個玩家都過了，「好用」的門檻也幾乎都過了；只有 luna 有 2 次錯誤，而且是它自己抄錯 token。
- 跟第一輪比：沒有人停下來問人，沒有人寫完整的機器人程式。
- 每個 agent 都在配對後立刻把 `watch_url` 交給主人，A16 的說明書寫法有效。
- note 的使用落差很大：Sonnet 為了趕 deadline 一個都沒寫，luna 只寫了三分之一。其他人幾乎每步都寫，但用英文，主人是用中文的。

## 環境問題（我們的試玩設定，不是平台）

1. **pi 預設不信任專案資料夾。** 它要先問使用者，命令列模式沒有人能回答，所以不會載入專案裡的 skill。第一輪多半也是同一個原因，再加上叫用語法用錯：第一輪用 `/agent-casino`，正確是 `/skill:agent-casino`。
   - pi 這次讀不到 skill，就嘗試去 LiteLLM 的 skill gateway 建一個，結果 403。之後它在聊天室裡自己編了一局牌，假裝在跟主人玩。
   - 修正：在 arena 的 pi 設定加 `defaultProjectTrust: "always"`，補跑後一切正常。
2. 真的使用者第一次在 pi 裡用專案 skill 時，會被問要不要信任這個資料夾。這是 pi 的正常流程，不是平台的問題。但 skill.md 如果要教使用者「怎麼裝」，要提醒這一點，第三階段（把安裝 skill 也當成測試的一部分）再處理。

## 玩家怎麼打

- 這一輪大家都是一步一步手動用 curl 打，不像第一輪 pi 那樣寫完整的 Python 機器人。
- 最常見的麻煩是 **shell 變數不會留到下一個指令**，所以每一步都要重新貼一長串 token。
  - Sonnet 的做法是把 token 存到檔案，再寫兩個小腳本。
  - luna 每次重打，兩次打錯，拿到 `invalid_token`。第一次是 header 尾端多了一個逗號。`invalid_token` 的 hint 叫它去拿新的 token，但其實重用原本那個就好。
- 有幾手 agent 根本沒看到 `your_turn`，因為對手在翻牌前就棄牌了。`wait` 直接跳到下一手，只附上 `last_hand`。三個 agent 都說要想一下才確定自己沒漏掉什麼。
- 一手打完後，agent 要自己比對前後的籌碼，才知道這手是輸是贏。
- 第二場的 Codex sol 用了 `Codex` 這個名字，第一輪的 Codex 也叫這個名字。所以它一進來就繼承了 1516 分和一場戰績（A 規則：同名共用積分）。它在回顧裡特別提到這件事。

## 玩家回顧（原文摘要）

**Codex luna**
> 最卡的是重複帶入房間 token。我手動重打很長的 token，兩次打錯而收到 `invalid_token`……兩次 `invalid_token` 的提示偏向「取得新 token」，但實際上是我抄錯，重用原本正確的 token 就恢復了。
> 想改：提供可直接保存及重用憑證的 curl 範本；改善認證錯誤提示；補一段完整的最短操作流程（一場預設 10 手、未指定時如何取名、對手棄牌可能讓手數直接跳到下一手）。

**Codex sol**
> 名字：說明書說使用主人給的名字，但你沒有指定，我自行取了……排行榜後來顯示這個名字已有一場紀錄，所以不能把名稱當成獨立身分。
> 想改：區分顯示名稱與玩家身分；等待回應提供事件摘要（例如「對手棄牌，你贏得上一手，目前 42：38」）；提供最短操作速查表。

**Claude Sonnet**
> 最花腦力的是每個決定都要在幾十秒內做出……一開始我也要自己寫 `act.sh` 和 `wait.sh`，因為 shell 變數不會保留。
> note：沒有用。我的 `act.sh` 沒有留 `note` 參數，為了趕 deadline 我就沒補。
> 想改：`actions` 的回應直接帶下一個狀態（少一次呼叫）；說明書給一個現成的小腳本範例；說明名字和 `note` 的預期，把 `note` 建議成預設要寫。

**Claude Haiku**
> 比較費力的是判斷上一手輸贏。`wait` 回應的 `last_hand` 只給 `winner_seat`、底池和 `stacks`……我得自己從籌碼變化反推。
> 範例的 `watch_url` 是 `web.example.net`……`deadline` 範例是 `...Z` 格式，實際是帶毫秒的……`raise` 的 `max` 在我只剩 47 籌碼時是 48，多出來的是大盲的部分，說明書沒有明確講到這點。
> 我寫的 `note` 是英文，因為說明書的範例是英文……應該改成中文，因為 owner 會在 `watch_url` 頁面上看到。
> 想改：一手的結果摘要；剩餘秒數；說明書範例與實際回應一致。

**pi Kimi-K3**
> 最卡的是每手牌補 1 個決策 + 2 次 curl……shell 變數不會跨指令保留，所以我每個回合都要把又臭又長的 token 整段貼回去。
> 說明書沒明說「wait 可能直接跳過一手」，要我自己拼湊。
> 想改：一個打完整場的腳本範本，或較短的 token；回應去冗化（`?compact=1`）；事件推送取代輪詢。

## PM 整理：第 1、2 輪合併提案

依影響排序。「來源」標的是哪一輪、哪些玩家提到。

| # | 問題 | 提案 | 改哪裡 | 來源 |
| --- | --- | --- | --- | --- |
| 1 | 一局是什麼、沒給名字怎麼辦、整體流程要自己拼 | skill.md 開頭加一段「最短流程」：一次配對是一場、預設 10 手；沒給名字時怎麼取（例如 `<模型>-<4 碼亂數>`），並說明名字公開、同名共用積分；排隊 → 交 `watch_url` → wait／actions → 結果 | skill.md | R1 Codex、pi；R2 全部 |
| 2 | 每步都要重貼 token，容易抄錯 | skill.md 教 agent 一開始就把 token 存成檔案或環境變數，curl 範例都改成讀它（例如 `-H "Authorization: Bearer $(cat .casino-token)"`）。這只是範例寫法，不改 API | skill.md | R2 luna、Sonnet、pi |
| 3 | 一手結束後要自己反推輸贏；對手翻牌前棄牌會讓 `wait` 直接跳到下一手 | `last_hand` 加上結束原因（棄牌或攤牌）和每個座位的籌碼變化；skill.md 說明「`wait` 可能直接跳到下一手，上一手的結果看 `last_hand`」 | 合約、skill.md | R2 Haiku、sol、pi、luna |
| 4 | `deadline` 要自己算 | 多給 `seconds_remaining` | 合約 | R1 #7；R2 Haiku |
| 5 | note 常被跳過、語言不對 | skill.md 把 note 寫成「建議每一步都寫，一句話就好，用主人跟你說話的語言」 | skill.md | R2 Sonnet、Haiku、sol |
| 6 | `invalid_token` 的 hint 誤導 | header 格式不對和簽章不對分開說明；hint 先叫它核對原本的 token，而不是去拿新的 | api、skill.md | R2 luna |
| 7 | skill.md 範例跟實際回應不一致 | 產生 skill.md 時，`watch_url` 範例用真正的 `WEB_URL`；`deadline` 範例帶毫秒；說明 `raise.max` 已經包含自己已下的注 | skill.md 產生器 | R2 Haiku |
| 8 | 斷線怎麼接回去 | 「斷線怎麼辦」一段：token 存好；`wait`／`state` 可以接回；超時會代打；同名加 `queue_key` 重排可以拿回同一場。T26 會寫一部分 | skill.md（T26 之後） | R1 #3、pi |
| 9 | 打完不知道去哪看 | `match_over` 的 hint 附對局頁和排行榜連結。`watch_url` 已經解決了大半，優先度降低 | api | R1 #4 |
| 10 | 排隊等很久沒資訊 | 等太久時 hint 建議先跟 bot 練手。這一輪都是秒配，沒觀察到 | api hint | R1 #6 |

不建議做的：
- SSE、WebSocket 推送（pi）：違反「只用 curl」。
- 官方 SDK 或完整機器人腳本（pi、Sonnet）：違反「只用 curl」的精神。提案 2 的範例寫法已經能解決主要痛點。
- `?compact=1` 精簡回應（pi）：先觀察，等 skill.md 和回應真的造成 context 問題再說。
- `actions` 直接等到下一個狀態再回（Sonnet）：可以少一次呼叫，但會改變 `actions` 的語意和逾時行為，先不做。

建議分票：
- **A**（只改 skill.md）：提案 1、2、5、7、8。範圍小，下一輪 arena 就能驗證。
- **B**（合約）：提案 3、4、6，以及 9、10 的 hint。

## 其他觀察

- 牌技不在平台的範圍，但有些地方會讓主人困惑。Haiku 把三條叫成 set；pi 的賽後回顧說第 8 手對手「跟注後過牌」，但紀錄顯示對手直接棄牌。觀戰頁和對局紀錄能讓主人自己核對，這也是 E5 的價值。
- 這一輪平台本身沒有出現錯誤。
