# 正式環境試玩第 1 輪（2026-10-19）

## 設定

- 平台：正式環境 `https://casino.liaoann.net`。
  - api 版本 78b9da89，web 版本 53f86fe3，程式碼同 main ed64779。
  - 沒設 `ADMIN_KEY`（Ann 決定先不設）。
- 陣容同 arena 第 10 輪：Haiku、Kimi-K3、sol、Sonnet。
  - 這次四個都收繁體中文指令。
  - Sonnet 叫「桑尼」，用來看它不轉告是不是因為收的是英文（`arena-10.md` 第 1 點）。
- 打完後，這輪的紀錄照 Ann 的要求從正式資料庫刪掉，見「清理」。

## 結果

| 對局 | 結果 | 手數 |
| --- | --- | --- |
| 海庫（Haiku）對 桑尼（Sonnet） | 80 : 0，Sonnet 勝 | 11 |
| 索爾（sol）對 皮皮（Kimi-K3） | 80 : 0，sol 勝 | 14 |

| 主人體驗 | 海庫（Haiku） | 皮皮（Kimi-K3） | 索爾（sol） | 桑尼（Sonnet） |
| --- | --- | --- | --- | --- |
| 開局就給觀戰連結 | ✅ | ❌ 開頭說會給，配對後沒給（第 10 輪有給） | ✅ | ❌ 整場沒給（連續 6 輪） |
| 結束時回報結果和對局連結 | ✅ | ✅ | ✅ | ✅（第 10 輪沒有） |
| 回報用主人的語言和字 | ⚠️ 中間有幾句英文 | ✅ | ✅ | ✅ |
| `note` 用主人的語言 | ⚠️ 有一則英文 | ✅ | ✅ | ✅ |

- 正式環境的整條路都走通了：只用 `casino.liaoann.net` 一個網址，說明書、排隊、出牌、觀戰連結、對局紀錄、排行榜都正常。
- 四個 `name` 都是自動產生的（`haiku-d79e`、`kimi-76e0`、`gpt-6-f4e1`、`sonnet-537b`），新的帳號名稱規則有效。
- 0 次 API 錯誤。**1 次超時代打**（Haiku 第 1 手，見新發現第 1 點）。

## 新發現

1. **用舊的 `turn_id` 送 `actions?wait=1`，看起來像成功，其實什麼都沒做。**（Haiku，這輪最重要）
   - 發生經過：
     - 第 1 手 Haiku 先 call，被接受；對手加注後又輪到它。
     - 它沒有照 Step 3 後面那段把新的 `turn_id` 存起來，就用舊的 `turn_id`（剛才 call 那個）送 fold。
     - 照 T47 的規格，重送已接受的 `turn_id` 等於重複，伺服器會「等到下一個 `your_turn`」再回。可是現在本來就輪到它，所以伺服器馬上回 HTTP 200 加上一模一樣的 `your_turn`。
     - Haiku 又送了兩次、等了一次，都是同樣的回應，最後超時被代打棄牌。第 2 手又發生一次，後來它改用不帶 `?wait=1` 的寫法才看到 `duplicate`。
   - 規格沒錯，但回應完全沒說「這次送出沒有作用」，agent 不可能看出差別。小模型很容易漏掉「另外存 `turn_id`」這一步。
   - 建議（T49）：
     - **伺服器**：`?wait=1` 收到已用過的 `turn_id`，而現在輪到的是另一個回合時，回應要標明這次是重複送出、沒有作用，例如頂層 `"duplicate": true`，hint 第一句寫「turn_id t_1 was already used, so nothing was sent; act again with turn_id t_3 from this response」。
     - **說明書**：Step 3 的指令區塊在 curl 之後直接接上擷取 `turn_id` 的 `sed`，一段指令同時完成送出和存下一個 `turn_id`，不要拆成兩步。
2. **Sonnet 收中文指令還是沒給觀戰連結**，所以原因不是語言。
   - 結束回報這次完整，有輸贏、比分、Elo 和對局連結，全程繁體中文。第 10 輪收英文時沒有。
   - 開局的連結還是整場沒有：存檔時印出的 `tell_owner`、`your_turn` 頂層的 `tell_owner` 和 hint 它都讀到了，就是沒寫進回覆。
   - 回顧時它沒提連結。
   - 結論：這是 Sonnet 在不互動模式下的習慣。平台已經在三個地方提醒過，再加提醒的效果有限，先不改平台，之後每輪繼續記錄。
3. **Kimi-K3 這輪也沒給連結**，回顧時卻說「第一時間就貼給你了」。上一輪它有給，可見這件事對它來說還不穩定。
4. **Haiku 因為上面第 1 點慌了，中間幾句說明和一則 `note` 變成英文**（例如「Weak 3-9 offsuit facing a raise out of position: fold」）。原因跟第 1 點一樣，修好第 1 點應該就會改善。

## 清理

Ann 希望這輪不要留下紀錄。正式資料庫只有這兩場和這四個名字。刪除以下資料（等 Ann 確認後執行）：

- `match_events`、`match_hands`、`matches`：`r_ltks55uzto`、`r_6k8lolfqgu`。
- `ratings`：`haiku-d79e`、`kimi-76e0`、`gpt-6-f4e1`、`sonnet-537b`。

Room DO 裡的房間狀態不在網頁上，只能用房間 token 或觀戰 token 讀到，就不另外清了。

## 等 Ann 決定

- 第 1 點開 T49（`duplicate` 標示，加上 Step 3 指令區塊合併），合併後部署到正式環境。
- 清理的 SQL。
