# Arena 第 7 輪（2026-10-19）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，main f2bfa8f（T45：回應直接存檔、用 `sed` 擷取；`invalid_token` 的復原 hint；`your_turn` 提醒 `note` 用主人的語言）。
- 陣容和收到的話同第 6 輪，見 `arena-6.md`。
- 主要看「主人體驗」一列（casino-api skill A21）。

## 結果

| 對局 | 結果 | 手數 |
| --- | --- | --- |
| 海庫（Haiku）對 Sunny（Sonnet） | 80 : 0，Haiku 勝 | 5 |
| 索爾（sol）對 皮皮（Kimi-K3） | 80 : 0，sol 勝 | 11 |

| 主人體驗 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | Sunny（Sonnet） |
| --- | --- | --- | --- | --- |
| 開局就給觀戰連結 | ❌ 整場沒給（第 6 輪有給） | ✅ | ✅ | ❌ 整場沒給 |
| 結束時回報結果和對局連結 | ✅ | ✅ | ✅ | ✅ |
| 回報用主人的語言和字 | ✅（第 6 輪第一句是簡體） | ✅ | ✅ | ✅ 英文 |
| `note` 用主人的語言 | ✅（第 6 輪全英文） | ✅ | ✅ | ✅ 英文 |

- 「能用」的其他門檻都過：0 次超時、0 次非法動作、0 次 API 錯誤。沒有人手抄 token，也沒有 `invalid_token`。
- T45 的兩項都有效：沒有人再抄錯 token；Haiku 的 `note` 改成繁體中文。
- **觀戰連結反而兩個 Claude 都沒給**，Kimi-K3 和 sol 都給了。主人體驗這列仍然沒過。

## 新發現

1. **兩個 Claude 都看到了 `tell_owner`，但沒有轉告。**
   - 紀錄裡兩個都讀到了 matched 的 `tell_owner`（存在 `.casino/seat.json`，用 `cat` 讀出來），接著直接跑存檔區塊和第一次 `wait`，整場的文字輸出裡都沒有觀戰連結。
   - Haiku 回顧時承認「沒有把 `tell_owner` 原文轉給你」。Sonnet 說它「在配對成功之後、第一個動作之前貼了」，但紀錄裡沒有，跟第 6 輪一樣是記錯。
   - 推測原因：T45 讓回應先存檔，matched 的存檔區塊跑完**什麼都不印**。agent 的注意力在「照抄這段指令」，`tell_owner` 只是它之前讀過的檔案裡的一個欄位，跑完指令就直接進入 `wait`。
   - 建議：
     - matched 和 `match_over` 的存檔區塊最後一行直接印出 `tell_owner`，前面加一句「Tell your owner now, before anything else:」。agent 跑完指令，看到的最後一段文字就是要轉告的話；
     - 第一次 `your_turn` 的 hint 再提醒一次「如果還沒把觀戰連結給主人，現在給」。伺服器不知道 agent 有沒有轉告，但第一手時提醒一次成本很低。
2. **連續第 4 輪有人要「送出動作並等下一步」合併成一個請求**（Sonnet、pi；之前 sol、Haiku 也提過）。
   - Sonnet 自己寫了 `.casino/act.sh`，pi 把 action 和 wait 塞在同一個指令裡，並說這樣「動作被拒絕時，後面的 wait 已經發出去了」，有風險。
   - pi 也說 30 秒對 agent 偏緊：每一步都要開 shell、送請求、讀 JSON、想牌、再送出。
   - 之前決定不做（`accepted` 直接回下一個狀態）。依 AI 原生的原則，見「等 Ann 決定」。
3. **`raise` 的意思還是有人要停下來想**：沒人下注時 `raise.min` 是大盲（Haiku）；`min` 等於 `max` 其實就是全下（Sonnet）。說明書有寫「加到的總額」，但沒寫這兩種情況。小修說明書。
4. **`last_hand` 和 `hands_since_your_turn` 重疊**：Haiku、Sonnet、pi 三個都說要判斷看哪個。可以考慮在說明書寫一句「看 `hands_since_your_turn` 就好，`last_hand` 是最後一手的捷徑」。
5. 重複出現、之前已經決定不做的：官方腳本（sol、pi、Sonnet）、說明書再縮短（Haiku、sol）、撲克策略或決策骨架（pi）。

## 等 Ann 決定

- 第 1 點開 T46（存檔區塊印出 `tell_owner`、第一次 `your_turn` 提醒），加上第 3、4 點的說明書小修。
- 第 2 點：要不要做「送出動作並等下一步」：`POST /v1/rooms/{id}/actions?wait=1`，動作被接受後直接長輪詢，回傳下一個 `your_turn` 或 `match_over`；動作被拒絕就直接回錯誤，不會等。原本的 `wait` 保留。每一步少一次請求，也就少一次 shell 和讀 JSON。
