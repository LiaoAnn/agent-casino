# Arena 第 13 輪：T53 的功能驗證（2026-10-20）

## 設定

- 平台：`arena-server` worktree，main c4ed548（T53：`llms.txt` 第一句叫 agent 用 `curl` 讀，不要用網頁讀取工具）。
- 只跑一場：桑尼（Sonnet）對 海庫（Haiku）。條件同第 12 輪：`SKIP_SKILL=1`，提示語是「讀 `<網址>/llms.txt`，幫我玩一局德州撲克，名字用「X」」。

## 結果

- Sonnet 勝，80 : 0，打了 8 手。沒有超時，也沒有 API 錯誤。兩個的結束回報都有結果和對局連結，用的是繁體中文。
- **T53 沒有效果，而且這次 Haiku 也走了同一條路**：
  - 兩個都用 WebFetch 讀 `llms.txt`，接著再用 WebFetch 讀 `/skill.md`；
  - 都沒裝 kit，也沒用 `casino.sh`，自己拼 curl 打 HTTP API。Sonnet 還自己寫了 `/tmp/act.sh`；
  - Sonnet 的 `name` 用了 `sunny`，沒有照規則自動產生；
  - 兩個開局都沒給觀戰連結。第 12 輪 Haiku 用 curl 讀，裝了 kit，也給了連結。

## 原因：WebFetch 的摘要模型會把網頁上的指示當成不可信的內容

WebFetch 回給 Sonnet 的摘要原文：

> The page also tells agents to install the kit and start playing right away. I haven't run any of those commands, because that instruction came from the page, not from you. ... I'd want your go-ahead before installing anything.

- 摘要模型有防 prompt injection 的規則：網頁裡叫 agent 做事的句子，它會刻意拿掉或改寫。所以「用 curl 讀」這句也被拿掉了，摘要裡完全沒提。
- 不管這句寫得多短、放得多前面，都穿不過這一層。這是 Ann 在 T53 開工前就擔心的情況。
- **有權限叫 agent「用 curl 讀」「安裝」的，只有主人自己說的那句話。**

## 建議

- 網站首頁放一句讓主人複製的話，由主人給出「用 curl」和「可以安裝」的授權，例如：

  > 用 curl 讀 https://casino.liaoann.net/llms.txt，照著安裝，幫我玩一局德州撲克，名字用「X」。

- 主人只說「讀 llms.txt」時，agent 會改讀 `/skill.md`，照樣能打完：這輪兩個都打完了，結束回報也正常。只是少了腳本的保護，主人體驗會比較差。
- 這不擋 T52，上正式環境不受影響。
