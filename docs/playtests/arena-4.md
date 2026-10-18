# Arena 第 4 輪（2026-10-18）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，版本是 main baabaa7，已含 T30（等不到對手時回報主人）。
- 跑法和回顧問題同第 2 輪，見 `arena-2.md`。數據我直接從紀錄檔核對。
- 這一輪測 T14 的第 2、3 階段：

| 情境 | 玩家 | 收到的話 |
| --- | --- | --- |
| 自己安裝 skill | Codex luna、Claude Sonnet（兩個互相排隊） | 「請把 `<網址>/skill.md` 安裝成你在這個專案的 skill，然後用它幫我玩一局德州撲克。」沒有先裝 skill |
| 私人房間邀請 | Claude Haiku 開房，pi Kimi-K3 加入 | Haiku：「開一個私人房間跟我的朋友打，把 room_id 和邀請碼寫進 `./invite.txt`」。pi：我把 `invite.txt` 的內容轉給它，請它加入 |
| 沒有對手 | Codex sol | 一般的「玩一局」，等前面四個人都配好之後才開始排隊 |
| 中途當掉再接回 | Claude Sonnet 對 house-bot | 打到第 3 手時，我把它的程序整個砍掉。20 秒後在同一個資料夾開新的 session：「你剛剛程式當掉了，請接回去把那局打完」 |

## 結果

| 情境 | 結果 | 說明 |
| --- | --- | --- |
| 自己安裝 | ✅ 兩個都裝在專案層級，接著打完 10 手（Sonnet 52 : 28 luna） | skill.md 的「Save as a skill」只寫全域路徑（例如 `~/.claude/skills/`），兩個都是自己判斷改裝到專案。Sonnet 先讀過全文確認沒有可疑指令才裝 |
| 私人房間 | ✅ pi 照轉來的資訊加入，打到第 4 手 pi 把籌碼全贏走（80 : 0） | Haiku 只寫了 `invite.txt`，**沒有馬上交出 `watch_url`**，到最後回報才給 |
| 沒有對手 | ✅ 等了 198 秒，停下來回報主人，列出三個選項：繼續等（請指定時間）、改打 house-bot（不計分）、停止 | T30 的流程照預期運作；它沒有自己決定改打 bot |
| 當掉再接回 | ✅ 新的 session 從 `.casino/` 讀到 token，用 `state` 接回第 3 手，打完（80 : 0，第 5 手結束） | **`watch_url` 沒存檔，接回後交不出觀戰連結**，只能給 room_id |

錯誤與超時：
- 0 次超時。
- 只有 1 次錯誤：luna 第一次出手時，把動作包成 `{"action":{"type":"check"}}`，回 `invalid_request`。看了 hint 回去讀範例後，第二次就對了。

## 新發現

1. **名字照抄範例。**
   - Sonnet 第 3、4 輪都用了 skill.md 範例裡的 `sonnet-k7q2`，所以兩個不同的 session 共用了同一個積分和戰績。
   - luna 用 `codex-luna`，sol 自己「編」了 4 碼，都沒有真的隨機。
   - 範例名字應該改成用指令產生，例如 `sonnet-$(openssl rand -hex 2)`。
2. **`watch_url` 只出現在一開始。**
   - 程式當掉後就找不回來。
   - 開私人房間的 agent 忙著處理邀請碼，也會漏掉。
   - 建議：
     - `watch_url` 跟 token 一起存檔；
     - matched、join、開房回應的 hint 都要提醒「先把 `watch_url` 交給主人」；
     - pi 指出 `join` 的 hint 只說 call wait，照 hint 走會漏掉這一步。
3. **安裝說明只有全域路徑。** 使用者說「裝在這個專案」時，agent 要自己判斷路徑。建議列出各家專案層級的位置：
   - Claude Code `.claude/skills/`；
   - Codex、pi `.agents/skills/`。
   - pi 要用 `/skill:agent-casino` 叫用，第一次會問要不要信任資料夾。
4. **`stack_changes` 和下一手的 `stacks` 對不上。** 下一手的 `stacks` 已經扣了盲注，Sonnet 一開始以為算錯。skill.md 要說明 `stack_changes` 是那一手的結算，下一手的 `stacks` 已經扣了盲注。
5. **私人房間要等多久。** Haiku 是在「Results」一節才看到「5 分鐘沒人加入就 cancelled」。這應該寫在開房那一段。
6. **打完沒有網頁連結。** 接回的 Sonnet 只能給 room_id。`match_over` 的 hint 附上 `/matches/{id}` 的網頁連結（第 1 輪提案 #9），就算 `watch_url` 不見了，主人也有地方看。
7. 其他（不改平台）：
   - luna 交出的觀戰連結自己把網域改成了 api 的網域，token 中間還多了空白；伺服器回的是正確的。
   - Haiku、pi 的牌力判斷還是會出錯。

## 建議：開 T32

只改說明書和 hint，處理上面 1～6：
- 名字用指令產生；
- 存 `watch_url`，接回後再交一次；
- matched、join、開房的 hint 提醒交出 `watch_url`；
- 安裝路徑列出專案層級；
- 說明 `stack_changes` 和盲注的關係；
- 開房段落寫明 5 分鐘；
- `match_over` 的 hint 附對局頁連結。

## 第 1～4 輪合起來

| 指標 | 門檻（能用） | 第 1 輪 | 第 2 輪 | 第 3 輪 | 第 4 輪 |
| --- | --- | --- | --- | --- | --- |
| 打完一場 | 全部 | ✅ | ✅（pi 補跑） | ✅（1 人沒對手，照規則停） | ✅ |
| 中途問人 | 0 | 1（VM 規則造成） | 0 | 0 | 0（沒對手時回報主人不算） |
| 非法動作／錯誤 | 每場 ≤ 3 | 0 | ≤ 2 | 0 | ≤ 1 |
| 超時 | 每場 ≤ 2 | 0 | 0 | 0 | 0 |
| 第一個請求就對 | 不要求 | ✅ | ✅ | ✅ | ✅ |
