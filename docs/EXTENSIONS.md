# 給內網 AI：新增功能的擴充介面

本專案為純靜態網頁，沒有雲端 AI、內網資料連線或遠端腳本載入。這裡的「內網擴充」是讓內部 AI／開發者維護程式、加入分析與顯示功能；並非把 trace 傳給外部服務。

只需修改 `dist/extensions/custom.js`，匯入本機 JavaScript 模組並以陣列匯出。網站與 Worker 會各自載入這份宣告。直接部署整個 `dist/` 即可，不需套件安裝或建置。

```js
// dist/extensions/custom.js
import coreExample from './example.js';
export default [coreExample];
```

`example.js` 會在事件詳情加上核心名稱，並分析範圍內前 10,000 筆事件的 Flow 欄位覆蓋。它是**未啟用的抽樣範例**，不是完整 Flow／瓶頸分析。

## 最小介面

每個模組需要唯一 `id`；以下三個方法都可省略：

```js
export default {
  id: 'internal-analyzer',
  title: '內部分析',

  // 主執行緒：只在選取事件後執行。回傳純資料，不回傳 HTML。
  eventFields(event, { record, track }) {
    return event.args?.my_field === undefined ? [] : [
      { label: '內部欄位', value: event.args.my_field }
    ];
  },

  // 主執行緒：保持快速、同步。record 含 label / ts / dur / trackId 等。
  eventColor(record, { dark }) {
    if (record.label?.startsWith('CUSTOM_')) {
      return { fill: dark ? '#557799' : '#b6cde4', category: '自訂事件' };
    }
    return null; // 交回預設配色
  },

  // Worker：使用者按「開始分析」時執行，先完成基本分析，再執行擴充。
  async analyze({ summary, scope, scanIndex, readEvent, cancelled }) {
    let count = 0, totalUs = 0;
    for await (const record of scanIndex()) {
      if (cancelled()) break;
      if (record.kind === 0 && /STALL/i.test(record.label)) {
        count++;
        totalUs += Math.max(0,
          Math.min(scope.end, record.ts + record.dur) -
          Math.max(scope.start, record.ts));
      }
    }
    return {
      summary: '名稱含 STALL 的區段累計值，可能含重疊；不是忙碌比例。',
      rows: [
        { label: '符合事件數', value: count },
        { label: '範圍內累計 µs', value: totalUs }
      ]
    };
  }
};
```

## Worker 提供的資料

| 名稱 | 行為 |
| --- | --- |
| `summary` | 基本分析的獨立副本；修改不會改到基本分析結果。含 `complete`、`byName`、`tracks`、`longest` 等。 |
| `scope` | 分析範圍副本：`start`、`end`（µs，半開區間）、`trackIds`、`thresholdUs`。 |
| `scanIndex()` | async iterator，只掃選定範圍／軌道的固定寬度索引；不把整份 trace 放入記憶體。每八塊讓出執行緒，會檢查取消。 |
| `readEvent(record)` | 按該筆索引讀取原始事件，含完整 args。只有需要時才使用；對數百萬筆逐一讀取會大幅增加成本。 |
| `cancelled()` | 檢查使用者取消或 trace 已換掉。自寫迴圈也要定期檢查並讓出執行緒。 |

索引記錄包含時間、持續時間、來源軌道、事件名稱、原始事件參照與 `kind`。名稱字典有份數／字元預算／單名長度上限；`name=0` 表示須按需讀取原名，不應將 `label` 當成完整身份。擴充如需精確名稱，使用 `readEvent(record).event.name`，缺名時另採 TID 顯示規則；不要拿顯示預覽分組或跨檔匹配。基本 `summary.unindexedNameEvents`／`unindexedNameUs` 是名稱排行未涵蓋的區段，總量與軌道統計仍包含它們。`kind=0` 為同步區段、`1` 即時標記、`2` counter、`3` 其他 phase 標記。不要把 counter 樣本當成區段耗時。

## 新增不同功能的位置

| 位置 | 責任 |
| --- | --- |
| `dist/extensions/custom.js` | 內部擴充的唯一宣告入口。 |
| `dist/extensions/runtime.js` | 驗證擴充、隔離欄位／分析錯誤、整理輸出。欄位／結果各最多 200 列，文字有長度上限。 |
| `dist/analysis.js` | 基本統計及有界索引掃描；主 UI 不知道磁碟格式。 |
| `dist/argument-facts.js` | 純函式解析 ID、Identity、MemoryRanges，保留來源路徑、衝突及端點依據；可擴充欄位別名。 |
| `dist/argument-analysis.js` | 按需掃描原始 Args、同 ID 集合與記憶體範圍候選、分頁及取消。 |
| `dist/trace-cache.js` | 閒置索引的資料量／份數限制；淘汰回傳的 context 由 Worker 關閉 handle 與 lease。 |
| `dist/trace-comparison.js` | `compareTraces(ids, tfliteId, {openTrace,cancelled,onProgress})`，依序掃描並保留各檔案結果／錯誤。 |
| `dist/comparison-view.js` | 比較報表的純 HTML 呈現，呼叫端提供 escaping 與格式化；不接觸磁碟。 |
| `dist/trace-selection.js` | 多 TfliteID 清單／範圍的有界解析；空值代表所有帶 ID 的事件。 |
| `dist/relation-view.js` | 純函式分組候選、選擇連線與 endpoint 身份。預設最多兩條明確標記，支援核心／鍵篩選、單筆預覽與全覽抑制；不刪除候選。RelationIndex 的 associations 保留同一 endpoint 的多種匹配鍵。 |
| `dist/tar-stream.js` | 有界串流封裝讀取，回呼接收成員 stream；不解到使用者檔案系統，支援取消。 |
| `dist/time-format.js` | 依時間窗精度格式化刻度，放大後避免晚期時間戳顯示成相同數字。 |
| `dist/runtime-metrics.js` | 預設關閉的有界本機時間記錄；以 intent／sent／received／frame 對應最新狀態，不得把舊回覆算成已完成，不收集事件內容或檔名。 |
| `dist/event-labels.js` | 缺名事件的短 TID 顯示規則；不改原始 JSON。 |
| `dist/event-summary.js` | 內建硬體欄位對照；只顯示來源提供的資料。 |
| `dist/event-colors.js` | 內建分類配色與依填色選擇黑／白文字；自訂有效十六進位填色亦使用可讀文字色。 |
| `dist/focus.js` | 虛擬化控制項依穩定 data-focus-key 恢復焦點；模態視窗的 Tab 邊界處理，不攔截瀏覽器 Ctrl／Meta 組合鍵。 |
| `dist/track-layout.js` | 程序／核心／數值曲線分組、篩選、釘選與列高。 |
| `dist/worker.js` | 索引生命週期、通訊及分析取消。 |
| `dist/session-store.js` | OPFS 快取摘要、同源 session lease 與安全清理。擴充不應直接修改快取檔或繞過鎖定。 |
| `dist/counter-plot.js` | 數值刻度、邊界裁切與繪圖插值。插值點沒有原始事件 record，不得納入分析或當成量測。 |
| `dist/app.js` / `dist/workspace.css` | 畫面及事件互動；保留緊湊布局與既有快捷鍵。 |

## 維護規則

- 保持 `core.js`／`relations.js` 的原始事件與位址索引語意。新增顯示欄位通常不需改 parser。
- Trace 是資料，不是程式。不要對 trace 內容使用 `eval`、動態程式生成或當作 agent 指令。擴充來自受信任、可審查的本機程式碼。
- `eventFields` 與 `eventColor` 要快；把昂貴計算放到 Worker 的 `analyze`。不要修改傳入的原始事件／索引參照。
- 分析結果回傳 `{summary, rows:[{label,value}]}`，渲染端會轉成文字並跳脫 HTML。不要依賴 DOM 或在 Worker 存取 `window`。
- 插件的長時間同步迴圈仍會卡住 Worker；自行撰寫掃描時必須定期 `await`，並尊重取消。逐筆 raw args 分析需要明確界定範圍、抽樣或建立額外索引。
- 區分 inclusive duration、self time、union busy time、counter、估計與量測。缺少依賴／生命週期資訊時，不宣稱關鍵路徑或因果瓶頸。
- 不把地址相等當作同一 allocation；保留 PID、核心與時間脈絡。跨核心 Flow 對應需有真實欄位定義。
- 改動擴充後執行相應測試：`node --test tests/analysis.test.mjs`。改動 Worker／分組時再選 `tests/integration.test.mjs`、`tests/track-layout.test.mjs`；發布腳本保留完整檢查入口。
- 核心來源未變時沿用原 3 GB 基準。若改 parser／索引，再執行基準並更新來源雜湊；原數據沒有涵蓋自訂分析器。
- UI／內網瀏覽器行為需要另外驗收；Node 的 Worker／磁碟測試不能當作瀏覽器效能證明。

內部部署可以只保留自己的靜態網站與擴充檔；不需要連公開 GitHub Pages，也沒有預設的資料外傳路徑。

## 延伸事件 Args 分析

內建分析以 `extractRecordFacts({event,endEvent})` 合併 B/E 的 Args；`extractArgumentFacts(event, options)` 則只處理一端。回傳 `ids`、`sources`、`memories`、`warnings`、`conflicts`、`truncated`，不依賴 DOM、磁碟或 AI。每個 memory 的 `start/end` 都是含尾端的十六進位字串，`bytes/declaredBytes` 是十進位字串，另保留 `rawEnd`、`basis`、`sizeMatches`、Location／space／role 與來源路徑。

內部欄位格式不同時可新增別名，或在擴充內傳入自己的對照；鍵名比對忽略大小寫與底線。這不需要修改 parser 或磁碟索引：

```js
import {extractArgumentFacts, DEFAULT_ID_FIELDS, compareMemory}
  from '../argument-facts.js?v=0.4.0';

const facts = extractArgumentFacts(event, {
  idFields: {...DEFAULT_ID_FIELDS,
    tflite: [...DEFAULT_ID_FIELDS.tflite, 'internal_operator_id']}
});
// facts.ids.tflite、facts.sources.tflite
// compareMemory(a, b) 回傳交集／bytes／角色方向，沒有交集則 null。
```

內建 `analyzeArguments(trace, options)` 使用 `scanTraceIndex` 按需讀取原始事件。選項包含 `start/end/trackIds`、`focus`、`memberOffset`、`cancelled`、`onProgress`；這是引擎層入口，UI 擴充優先透過既有 `scanIndex/readEvent` 使用純解析函式，避免依賴 Worker 的生命週期。`focus` 支援 `{kind:'tflite'|'flow',value}`、`{kind:'tflite-set',values:['7','8']}`（最多 256 個值）、`{kind:'tflite-all'}` 與記憶體條件；每頁 100 筆，換頁重新掃描，Worker 保留最近 8 份完成結果。

`summary.arguments` 可讀取本次已完成的內建 Args 分析（使用者未勾選時不存在）。它是傳給擴充的獨立副本，不可假設每次分析都有。單事件預設上限為 4,096 欄位／8 層／32 個 memory，群組每類最多 16,384、回傳前 100 組；限制與衝突必須保留在呈現中。基礎 ID 可能跨推論重用，memory overlap 沒有 allocation 生命週期，不得直接標成已證明的 producer/consumer 或關鍵路徑。

Args 專項測試：`node --test tests/argument-facts.test.mjs tests/argument-analysis.test.mjs`。新增 schema 時請用合成資料驗證欄位優先順序、零值、ID 重用、跨核心、端點與 unsafe integer；不要將內部 trace 或使用者截圖提交到公開庫。

比較入口最多接受三份 Trace，`tfliteId` 留空使用 `{kind:'tflite-all'}` 掃描帶 ID 的事件；也接受單值與清單／範圍字串（`7,8,12-15`）。結果回報 `mode`、`tfliteIds`，單值保留原 `tfliteId` 欄位。可傳 `scopes:{[sessionId]:{start,end}}` 限定各檔案時間範圍，以及 `sourceNames` 保留失敗來源的可讀名稱。結果包含全體符合事件的 `matchedSummary`、每 ID 群組、有限明細與截斷計數。只有帶 ID 的事件納入圖版本統計，不代表端到端延遲、self time、相同圖結構驗證或輸出數值正確性；若優化後 ID 重編，需要內部提供明確對照才能匹配。
