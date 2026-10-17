---
name: ticket-workflow
description: 在這個 repo 接一張 ticket 到合併的規則：開工前確認、範圍與資料夾、合約凍結、測試與驗證、PR 格式、自動合併條件。開始做 ticket、開 PR、review 或驗證別人的 PR 時使用。
---

# 做一張 ticket

## 開工前
1. 讀 `docs/tickets.md` 裡你那張 ticket：範圍、Blocked by、只改哪些資料夾、驗證指令、功能驗證。
2. 確認 Blocked by 的 ticket 都已完成（PR 已合併進 `main`）；沒有就不要開始。
3. 一張 ticket = 一個 branch = 一個 PR，約 500–1000 行（不算 lockfile 和自動產生的檔案）。branch 名稱 `t<編號>-<簡短英文>`，PR 標題開頭寫 ticket 編號，例如 `T02: cards and hand ranking`。

## 做的時候
- **只改 ticket 寫的資料夾。** 同時有別的 agent 在做其他 ticket，碰到範圍外的檔案就會打架。共用檔案（根目錄 `package.json`、`wrangler.jsonc`、CI 設定）只能新增，不能改別人寫的。
- **合約凍結**：不是合約 ticket 就不改 `apps/api/src/contract/`。真的需要，停下來向人說明，等人在 `docs/tickets.md` 另開合約 ticket。
- **範圍不對**：停下來向人說明，不要自己擴大或縮小範圍。
- **還沒有的東西用合約產生的假資料**，不要等別的 ticket。
- **不准削弱測試**：不刪、不跳過既有測試（CI 擋 `.skip`、`.only`），不調低門檻。
- 修 bug 時先把問題寫成會失敗的測試（規則相關的就用「種子 + 動作」），再修。
- 秘密（`TOKEN_SECRET`、`ADMIN_KEY`、Cloudflare token、登入憑證）只放在 Worker secret 或 GitHub Actions secrets。
- 不部署正式環境，除非 ticket 寫了而且人同意。測試環境可以自己部署。

## 怎麼驗
完成 = `pnpm check` 全過 + ticket 的驗證指令全過 + 功能驗證做過。

| 驗什麼 | 怎麼驗 |
| --- | --- |
| 規則 | 「種子 + 一串動作 → 預期結果」的案例 |
| 比牌 | 公開牌型對照資料當標準答案 |
| 不該發生的事 | 亂打機器人上萬手：籌碼總數不變、沒人超前行動、輪到人時合法動作不為空 |
| 介面跟說明書一致 | skill.md 從合約產生；抓出 skill.md 每個 curl 範例實際打一次，回應符合合約 |
| 狀況處理 | `casino-api` skill「狀況處理」表每列一個測試 |
| 從頭到尾 | `pnpm e2e`，只用 curl + jq |
| 參賽 agent 好不好用 | `agent-playtest` skill |

## 開 PR
照 `.github/pull_request_template.md` 的四段寫。

## 什麼時候可以自動合併
沒有標 🔒 `needs-human` 的 ticket，**全部**滿足就合併，不用等人：
1. CI 全綠。
2. 多面向 code review 沒有「必須修」的問題。review 要對照 ticket：有沒有做多、做少、寫死的數字、沒測到的分支、碰了範圍外的檔案。
3. **驗證的 agent 不是寫的那個。** 另一個 agent 在自己的環境重跑驗證指令和功能驗證，把結果貼在 PR。作者自己說「測過了」不算。
4. 沒碰到保護路徑（`CODEOWNERS` 列的那些）。

有 🔒 `needs-human` 的 ticket，前三項做完後等人核准。
