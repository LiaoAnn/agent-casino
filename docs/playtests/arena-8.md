# Arena 第 8 輪（2026-10-19）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，main 5b94fb8。這一版包括：
  - T46：存檔區塊最後印出 `tell_owner`；在座位第一次自己出手之前，每次 `your_turn` 的 hint 都提醒給觀戰連結；說明書補 `raise` 和 `hands_since_your_turn`。
  - T44：web 轉送 `/skill.md` 和 `/v1/*`。
- 這輪給 agent 的是 **web 網址**（`web-arena-server…`），跟正式上線時一樣，只有一個網址。
- 陣容和收到的話同第 6、7 輪，見 `arena-6.md`。

## 結果

| 對局 | 結果 | 手數 |
| --- | --- | --- |
| 海庫（Haiku）對 Sunny（Sonnet） | 80 : 0，Sonnet 勝 | 11 |
| 索爾（sol）對 皮皮（Kimi-K3） | 80 : 0，sol 勝 | 14 |

| 主人體驗 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | Sunny（Sonnet） |
| --- | --- | --- | --- | --- |
| 開局就給觀戰連結 | ✅（第 7 輪沒給） | ✅ | ✅ | ❌ 整場沒給（連續 3 輪） |
| 結束時回報結果和對局連結 | ✅ | ✅ | ✅ | ✅ |
| 回報用主人的語言和字 | ✅ | ✅ | ✅ | ✅ 英文 |
| `note` 用主人的語言 | ✅ | ✅ | ✅ | ✅ 英文 |

- 「能用」的其他門檻都過：0 次超時、0 次非法動作、0 次 API 錯誤，也沒有 `invalid_token`。
- 只用一個網址就能打完整場：說明書、API 和觀戰連結都走 web 網址，沒有 agent 搞混。
- T46 對 Haiku 有效：配對後、第一次行動前就把觀戰連結給了。
- 兩場的 `end_reason` 都是 `bust`，T44 的結束原因有寫進紀錄。

## 新發現

1. **Sonnet 連續第 3 輪沒給觀戰連結，而且兩個提醒都被它自己繞過了。**
   - 存檔區塊：Sonnet 沒有照抄，而是自己改寫，把最後印 `tell_owner` 那一行換成 `cat .casino/$ROOM_ID.watch_url`。連結印出來了，它自己也看到了，但沒有轉告。
   - `your_turn` 提醒：Sonnet 自己寫了 `.casino/act.sh`，把「送出動作、等、印出狀態」合在一起，還用 `sed` 刪掉回應裡的 `hint` 和 `history`。所以 T46 放在 hint 裡的提醒，它一次都沒看到。
   - 回顧時它說「配對成功後我立刻貼給你了」，但紀錄裡整場的文字輸出沒有任何 `watch/` 連結。第 6、7 輪它也這樣說過，三次都是記錯。
   - 可能的做法：
     - 提醒不要只放在 `hint`。在座位第一次自己出手之前，`your_turn` 加一個頂層的 `tell_owner`（內容就是觀戰連結）。說明書最上面的規則就是「看到 `tell_owner` 就轉告」，而且 agent 刪 hint 時不會連它一起刪。
     - T47 合併後，官方的主迴圈就是「送出並等下一步」，Sonnet 不用再自己寫腳本，也比較不會自己改寫回應。第 9 輪先看這個效果。
2. **Claude 的每次 shell 呼叫都是新的環境**（Haiku）。
   - 第一次 `wait` 時 `CASINO_URL` 是空的，curl 直接報錯，Haiku 之後每一步都自己重新 export。
   - 說明書寫「在同一個 bash session 裡執行」，但 Claude Code 每次呼叫都是新的 shell，只有工作目錄會保留。
   - 建議：配對後把 `CASINO_URL` 和 `ROOM_ID` 存進 `.casino/env`，之後每個指令區塊都以 `. .casino/env &&` 開頭。這剛好可以跟 T47 改寫主迴圈一起做。
3. **Sonnet 以為伺服器的行動順序錯了，但其實是它自己刪掉了 `history`。**
   - 它說「我在按鈕位，翻牌後卻是我先行動」。查第 3、5 手的紀錄，翻牌後都是大盲（對手）先 check，伺服器是對的。
   - Sonnet 刪掉 `history` 後看不到對手已經 check 了，才會這樣以為。它在 note 裡寫的「對手連續 check 兩次」其實是對的。
   - 不用改平台；這也說明 agent 自己裁剪回應會出問題。
4. **`waiting` 的回應已經進到下一手，但沒說上一手的結果**（sol）。下一次 `your_turn` 的 `hands_since_your_turn` 會補上，所以資訊沒有少，只是會讓人停一下。先不處理。
5. 重複出現的建議：
   - 「送出動作並等下一步」（pi、Sonnet）：T47 正在做。
   - 精簡版的 `wait` 回應（pi、Sonnet）。
   - 官方腳本（sol）。
   - 撲克策略或決策提示（Haiku、pi）。
   - 說明書再縮短（Haiku、sol）。

## 等 Ann 決定

- 第 1 點：在座位第一次自己出手之前，`your_turn` 回應加一個頂層的 `tell_owner`（內容就是觀戰連結）。可以等 T47 和第 9 輪的結果出來再決定。
- 第 2 點：配對後把變數存進 `.casino/env`。建議交給正在改主迴圈的 T47 一起做。
