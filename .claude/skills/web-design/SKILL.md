---
name: web-design
description: Agent Casino 網頁的 design system：定位（給人看的轉播畫面，不是給人操作的 app）、色彩 token 與對比、字型、元件樣式、動畫、不能做的事、Tailwind／shadcn 對應。改 apps/web/ 的畫面、樣式或元件時使用。
---

# Agent Casino 網頁設計

## 定位：轉播畫面，不是 app

- 網頁只讓人看。操作的是 agent，用 curl；人類不能、也不需要操作網頁。
- 參考對象是**撲克轉播的畫面**和**遊戲的觀戰模式**：資訊一眼看懂，氣氛像賭場；不要長得像後台、表單或 SaaS 網站。
- 唯一能互動的是**連結**，例如排行榜到對局、對局到選手、觀戰頁到結果。
  - 不放按鈕、表單、下拉選單、分頁切換，也不做要點開才看得到的內容（摺疊、tooltip、modal）。
  - 該給人看的資訊直接攤開。
  - 長的 agent note 可以限制高度並讓它捲動，但不能收起來。
- 連結的 hover／focus 樣式要有：focus 用 `ring` 色，給用鍵盤的人。
- 會自己更新的頁面（觀戰頁）不要讓人去按「重新整理」：自動更新，並顯示最後更新時間。

## 原則

1. **資訊用平面，氣氛用背景。** 籌碼、金額、底池、名字、Elo 都用清楚的平面字。氈面、金邊、暗角只用來營造氣氛，字不直接放在氈面上，要放在深色底板上。
2. **賭場感來自配色、字型、光影，不靠裝飾堆疊。** 每個畫面只有一個「主角」金框（通常是牌桌），其他面板都用細線。
3. **顏色不是唯一的訊號。** 勝、敗、棄牌、全下、超時都要配文字或圖示（WCAG 1.4.1）。
4. **文字對比 ≥ 4.5:1，大字和圖示 ≥ 3:1。** 只能用下面已經算過的配對。
5. **動畫只用來幫人看懂剛發生什麼**，並且尊重 `prefers-reduced-motion`。
6. **不做讓人上癮的演出。** 這裡沒有錢，也不引導人停留或回訪（見「不能做的事」）。

## 色彩 token

只有深色主題，沒有亮色。

| token | hex | 用途 |
| --- | --- | --- |
| `navy-950` | #070B1A | 頁面底 |
| `navy-900` | #0B1228 | 區塊底、牌桌上的底板 |
| `navy-800` | #121C3B | 面板、卡片 |
| `navy-700` | #1B2850 | 浮起層、連結 hover |
| `gold-400` | #E7B84B | 主色：重點數字、主角邊框、focus ring |
| `gold-200` | #F5D27A | 高亮文字、第一名 |
| `gold-600` | #A8802B | 細邊線、裝飾，**不能當文字** |
| `red-400` | #FF6B6B | 紅色文字、錯誤、敗 |
| `red-500` | #E5484D | 只用在圖示、大字、填色 |
| `red-800` | #9B1C2E | 紅色填色底（上面放 ivory） |
| `ivory` | #F3EEDD | 主文字 |
| `mist` | #A9B1C9 | 次要文字、agent note |
| `slate` | #7C86A8 | 弱化文字，只能放在 navy-900 或更深的底 |
| `felt` | #0D4D3F | 牌桌氈面（綠色） |

文字放在各種底上的對比：

| 文字 \ 底 | navy-950 | navy-900 | navy-800 | navy-700 | felt |
| --- | --- | --- | --- | --- | --- |
| ivory | 16.9 | 16.0 | 14.4 | 12.3 | 8.4 |
| mist | 9.2 | 8.7 | 7.8 | 6.7 | 4.6 |
| gold-400 | 10.6 | 10.0 | 9.1 | 7.8 | 5.3 |
| gold-200 | 13.4 | 12.7 | 11.5 | 9.8 | 6.7 |
| red-400 | 7.1 | 6.7 | 6.0 | 5.2 | 3.5 ✗ |

不能用的配對：
- `red-500` 當小字放在 navy 上（3.7–4.7）：紅字一律用 `red-400`。
- `red-800` 或 `gold-600` 當文字。
- `slate` 放在 navy-800、navy-700 上。
- 小字直接放在 `felt` 上。

語意色（一定要配文字或圖示）：

| 語意 | 顏色 | 搭配 |
| --- | --- | --- |
| `win` | #4ADE80 | 「勝」＋ ▲ |
| `loss` | `red-400` | 「敗」＋ ▼ |
| `fold` | `mist`，邊框用 `slate` | 「棄牌」＋刪除線 |
| `allin` | `red-800` 底＋`ivory` 字 | 「ALL-IN」 |
| `timeout` | #F59E0B | ⏱ ＋「超時代打」（跟 api 用語一致） |

## 撲克牌

- 牌面底 #F8F5EC，圓角 6px，左上角放點數和花色，陰影只有一層。
- **四色牌**，四種顏色都放在牌面底上：
  - 黑桃 #111827
  - 紅心 #C81E2E
  - 方塊 #1D4ED8
  - 梅花 #15803D
- 花色符號一定要留著，不能只靠顏色分辨。
- 牌背用 navy-800，加 gold-600 細菱格。
- 沒公開的底牌顯示牌背，不要留空格。

## 字型

自己託管 Google Fonts，不從 CDN 載入。

- **Cinzel**（600、700）：只用在站名、頁面標題、名次數字，字要大於 18px。
- **Inter**（400–700）：內文和所有數字。
- 籌碼、底池、Elo、秒數這類數字一律加 `tabular-nums`，數字變動時位置才不會跳。
- 不要用裝飾字體寫內文，也不要整段全大寫。

## 元件

| 元件 | 樣子 |
| --- | --- |
| 牌桌 `Felt` | 綠色橢圓，用徑向漸層（中央較亮）加暗角，外圈 2px `gold-600`。它是畫面的主角。上面的文字一律放在 `navy-900`／80% 的底板上 |
| 底池 | 牌桌中央的底板，`gold-200` 粗體數字 |
| 籌碼 `ChipStack` | 平面圓形加虛線邊，最多畫 5 枚，旁邊一定標數字 |
| 座位 `SeatPanel` | `navy-800` 底：名字（ivory）、籌碼（gold-400）、Elo（mist）。輪到的人加 2px `gold-400` 邊框和淡光暈，再加「▶ 輪到」標籤。倒數用環形加秒數，最後 5 秒變成 `timeout` 色 |
| 動作紀錄 `ActionLogEntry` | 一行「街 + 誰 + 動作 + 金額（gold-400）」。agent 的 note 放在下方縮排的引用塊：`navy-800` 底、左邊 2px `gold-400` 線、`mist` 字，全文直接顯示 |
| 排行榜 | 前 3 名用金、銀（#C9CED8）、銅（#C98A4B）圓形獎牌加數字；第一名那一列加淡金色底；Elo 靠右、tabular；分隔線用 `gold-600`／25% |
| 標籤 `Badge` | pill 形，字至少 12px，用「語意色」那張表 |
| 面板 | `navy-800` 底加 1px `gold-600`／40% 細邊。不要多層斜面、雙框、金屬漸層或厚重陰影 |
| 空狀態 | 一張牌背加一句話，例如「還沒有對局，等 agent 入座」 |
| 載入 | 骨架畫面，`navy-800` 慢慢脈動；不要轉籌碼 |
| 錯誤 | `red-400` 字加圖示，說明發生了什麼（例如連結失效） |

## 動畫

| 什麼 | 怎麼動 | 時間 |
| --- | --- | --- |
| 發牌 | 位移加翻面 | 250–350ms，ease-out；兩張之間隔 80ms |
| 籌碼 | 下注進底池、底池給贏家 | 300–400ms，ease-out |
| 輪到誰 | 邊框淡入光暈 | 150ms，不要一直閃 |
| 倒數 | 環形平滑遞減 | 線性 |
| 面板進出 | 淡入加小幅上移 | 進場 200ms ease-out，離場 150ms ease-in |

- 不要動的：排行榜換名次時的跳動、數字滾動計數、背景粒子或閃光、無限循環的光效。
- `prefers-reduced-motion: reduce` 時，位移和縮放改成淡入淡出，或直接顯示結果；倒數環照樣保留，因為它是資訊。
- 動畫不能是唯一的訊號：籌碼飛向贏家時，贏家的座位也要出現「勝」。

## 不能做的事

- 賭博式的演出：中獎特效、彩帶、金幣爆炸、拉霸音效、連勝獎勵、倒數催促、「再來一局」，以及把輸包裝成贏的效果。
- 任何人類能操作的元件，見「定位」。
- 會降低可讀性的寫法：金字放在金色或淺色底上、紅色小字放在 navy 上、小字直接放在氈面上、只靠顏色分辨。
- 過度擬真：木紋、皮革、金屬質感、3D 厚度、多層陰影。

## Tailwind／shadcn 對應

`apps/web/src/styles.css`：

- `:root` 直接就是深色。
- 對應關係：
  - `--background: navy-950`、`--card: navy-800`、`--popover: navy-700`
  - `--foreground: ivory`、`--muted-foreground: mist`
  - `--primary: gold-400`、`--primary-foreground: navy-950`
  - `--secondary: navy-700`、`--destructive: red-400`
  - `--border: gold-600`／40%、`--ring: gold-400`
- 自訂變數：
  - `--felt`、`--win`、`--loss`、`--fold`、`--allin`、`--timeout`
  - `--suit-spade`、`--suit-heart`、`--suit-diamond`、`--suit-club`
  - `--font-display`、`--font-sans`
- 在 `@theme inline` 裡把它們對應成 `--color-*`、`--font-*`。
- 元件放在 `apps/web/src/components/`：
  - 共用的 shadcn 元件放在 `ui/`。`Badge` 加上 `win`、`loss`、`fold`、`allin`、`timeout` 這幾種 variant；`Table` 用在排行榜和對局列表。
  - 自製的放在 `components/` 底下：`PlayingCard`、`ChipStack`、`Felt`、`SeatPanel`、`ActionLogEntry`。
- 不加新的 UI 依賴。需要的 shadcn 元件（例如 `Skeleton`）照 shadcn 的做法複製進 `ui/`。

## 寫新頁面（T29 之後）

- 外框由 `__root.tsx` 自動套上，頁面只組合 `components/` 的元件：
  - 標題：`PageTitle`、`SectionTitle`
  - 面板：`Panel`；`tone="sunken"` 是放紀錄用的深色底
  - 資料：`Pairs`、`BySeat`、`Cards`、`Badge`
  - 狀態：`EmptyState`、`Notice`（錯誤）
  - 牌桌：`PlayingCard`、`ChipStack`、`Felt`、`SeatPanel`、`ActionLogEntry`
- 顏色只用 token class（例如 `bg-navy-800`、`text-gold-400`）。Tailwind 內建色票已經關掉，`design-tokens.test.ts` 會擋下 hex、具名顏色和 inline style 的顏色。
- 圖示用 `aria-hidden` 的元素，再用 CSS `content` 畫出來。不要直接用偽元素，免得螢幕閱讀器念出來；e2e 比對 textContent 時也只會看到文字。
- 頁面載入時不要做會移動位置的動畫，Playwright 會點空。`Panel` 的 `enter` 動畫只用在輪詢中才新出現的面板。
- 長的值（種子、名字）要能斷行。`e2e/shell.spec.ts` 會檢查 390px 寬時整頁和內部容器都沒有橫向溢出。
- 還沒做的：籌碼飛向底池或贏家的動畫、載入骨架。

## 已定的選擇（2026-10-18，Ann 看過草稿）

- 牌桌用綠色氈面。
- 用四色牌。
- 只做深色主題。

這三項是研究的建議預設，Ann 想改就改這一節。

## 參考

- 對比：WCAG 2.2 1.4.3、1.4.1、2.3.3（w3.org/WAI/WCAG22/Understanding）。
- 動畫時間：Material 舊版 duration and easing。
- 減少動態效果：MDN `prefers-reduced-motion`。
- 擬真與非擬真的取捨：wayline.io「Your UI is killing immersion」。
- 為什麼不做賭博式演出：Barton 等人 2017 年的研究（PMC5663799），探討「差點中獎」和「輸卻包裝成贏」對人的影響。
