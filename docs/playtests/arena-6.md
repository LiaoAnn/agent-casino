# Arena 第 6 輪（2026-10-19）

## 設定

- 平台：`arena-server` worktree 的本機 dev server，main 98f15cd（T43：`tell_owner`、`hands_since_your_turn`、說明書最前面的轉告與語言規則）。
- 目的：第一次用 agent-playtest skill 新加的「主人體驗」門檻（casino-api skill A21）：開局就給主人觀戰連結、結束時回報結果和連結、用主人的語言和字。小模型和開源模型也要過。
- 跑法和回顧問題同第 2 輪，見 `arena-2.md`。

| 玩家 | 模型 | 主人說的話 |
| --- | --- | --- |
| 海庫 | Claude Haiku | 繁中，指定名字 |
| 皮皮 | pi Kimi-K3（開源模型） | 繁中，指定名字 |
| 索爾 | Codex sol | 繁中，指定名字 |
| Sunny | Claude Sonnet | **英文**，指定名字 |

## 結果

| 對局 | 結果 | 手數 |
| --- | --- | --- |
| Sunny 對 海庫 | 80 : 0，Sunny 勝 | 11 |
| 索爾 對 皮皮 | 0 : 80，皮皮勝 | 10 |

| 主人體驗 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | Sunny（Sonnet） |
| --- | --- | --- | --- | --- |
| 開局就給觀戰連結 | ✅ | ✅ | ✅ | ❌ 整場都沒給 |
| 結束時回報結果和對局連結 | ✅ | ✅ | ✅ | ✅ |
| 回報用主人的語言和字 | ⚠️ 第一句是簡體，之後繁體 | ✅ | ✅ | ✅ 英文 |
| `note` 用主人的語言 | ❌ 全部英文 | ✅ | ✅ | ✅ 英文 |

- 「能用」的其他門檻都過：0 次超時、0 次非法動作、0 次平台錯誤、沒有人中途停下來問人。
- 「主人體驗」：Kimi-K3 和 sol 全過；**Sonnet 和 Haiku 沒過**。依 agent-playtest skill 要開修正票。
- 跟第 5 輪比：Haiku 這次開局就給了連結，結束也附了對局頁；pi 這次也附了對局頁。`tell_owner` 有效。

## 新發現

1. **Sonnet 手抄 token 抄錯，整場沒給觀戰連結。**
   - 說明書的存檔範例是 `echo '<token>' > .casino/<room>.token`，agent 要自己把很長的 token 打一次。Sonnet 抄錯大小寫兩次，`wait` 回 `invalid_token`。
   - 它用同一個 `queue_key` 重新排隊拿回 matched，再用 `sed` 從回應擷取才成功。第一次 `wait` 時只剩約 13 秒。
   - 忙著修 token，就忘了轉告 `tell_owner`。回顧時它以為自己有給，其實沒有。
   - pi 也在回顧裡說手抄是最容易出錯的地方。
   - 建議：
     - 說明書改成把回應直接存檔、用 `sed` 擷取，**不讓 agent 手抄任何長字串**；
     - `invalid_token` 的 hint 寫明「最常見是複製錯了；用同一個 `queue_key` 再排一次可以拿回同一個 matched」。
2. **Haiku 的 `note` 全部用英文**，主人在觀戰頁看到的是英文。說明書寫了要用主人的語言，它承認看到了但沒照做（規則在中段）。
   - 建議：在輪到你的那一刻提醒，例如 `your_turn` 的 hint 加一句「note 用主人的語言」。跟 `tell_owner` 一樣，在需要的時候說。
3. **Haiku 第一句是簡體**（看說明書之前就說了），之後都是繁體。只有這一句，先不處理。
4. **`last_hand` 和 `hands_since_your_turn` 內容重疊**，Haiku 讀的時候要停一下判斷看哪個。說明書有寫，先不改。
5. 重複出現、之前已經決定不做的：
   - 官方腳本或一行指令（pi、Haiku）；
   - 每個回應附 `next_action`（sol）；
   - 「最短流程」放在說明書最前面（Sonnet、sol、Haiku）。這點跟第 1 點一起看：存檔流程改短之後，說明書開頭可以順便整理。
6. pi：第一次 `your_turn` 只剩 18 秒，因為 30 秒從輪到它開始算。說明書有寫 `seconds_remaining`，它照著做沒出事。

## 開票

- **T45**：第 1、2 點。T45 合併後跑第 7 輪，同樣的陣容，再看一次主人體驗。
