# 時跡 Trace Studio

**把時間，看清楚。** 純網頁 Chrome Trace JSON 工作台：時間軸、原始事件資訊、位址關聯，以及為大檔設計的本機磁碟索引。

**[開啟時跡](https://koviankevin.github.io/trace-studio/)** · [操作參考](https://perfetto.dev/docs/visualization/perfetto-ui) · [效能測試](docs/PERFORMANCE.md)

目前為 v0.1.0 初版。解析與索引已有自動化測試；**瀏覽器畫面、OPFS 實際效能與操作仍待人工驗收**。尚未證實比 Chrome tracing 或 Perfetto 更快；本專案的目標是在熟悉的操作上提供更清楚的資訊與大檔路徑。

## 使用

以最新版桌面 Chrome / Edge 開啟網站，選擇「開啟 Trace」或拖入 `.json` / `.json.gz`。支援根層事件陣列，以及 `{ "traceEvents": [...] }`。沒有檔案時會載入清楚標示的合成示範資料。

需要 HTTPS（本機開發可用 localhost）、OPFS 支援及足夠的瀏覽器儲存空間。檔案在瀏覽器內處理，不會上傳伺服器；沒有分析追蹤、外部字型或 CDN 依賴。快取保留在本瀏覽器的本站儲存區，下次開啟會還原最後完成的索引。左側可清除本站所有 Trace 快取，不會改動原始檔案。其他分頁正在使用同一份快取時可能因獨占檔案鎖而無法還原或清除。

## 功能

- Canvas 時間軸與可見軌道虛擬化、密度全覽、以滑鼠位置為中心縮放。
- X 完整區段、B/E 同步配對、i/I/R 即時事件、C counter 曲線；其他 phase 保留為標記。
- 程序與執行緒名稱、軌道篩選、釘選到頂部、雙擊軌道名稱展開高度。
- 事件名稱搜尋、最長 20 筆事件、完整原始欄位與 args、metadata、複製原始事件 JSON。
- 精確 address 關聯、標準 flow ID 與明確 defines / uses 關聯；點選跳轉及時間軸連線。
- 亮色與深色模式、指令選單與核心 Perfetto 操作。

## 操作

| 操作 | 按鍵 / 手勢 |
| --- | --- |
| 放大 / 縮小 | W / S（依實體鍵盤位置） |
| 向左 / 向右平移 | A / D |
| 以游標位置縮放 | Ctrl + 滾輪 |
| 滑鼠平移 | Shift + 拖曳 |
| 選取時間範圍 | 直接拖曳；拖曳兩端可調整邊界 |
| 事件詳情 | 點選事件 |
| 聚焦選取 | F |
| 相鄰事件 | `,` / `.` |
| 轉成範圍選取 | R |
| 切換詳情面板 | Q |
| 清除選取 | Esc |
| 尋找軌道 / 指令選單 | Ctrl P / Ctrl Shift P（Mac 使用 Cmd） |
| 所有快捷鍵 | ? |

導航的彈性動畫、按住加速與滾輪算法改寫自 Apache-2.0 授權的 Perfetto v48.0。這是核心操作相容，並未實作 Perfetto 的所有功能或外掛介面。

## 位址關聯

自動掃描 `args` 內的 `address`、`addr`、`ptr`、`pointer`（含常見底線／駝峰命名與巢狀欄位），以及形如 `0x1234` 的十六進位字串。精確位址會統一大小寫、進位及前導零：`"0x0000ABCD"`、`"0xabcd"`、`43981` 可以連到同一鍵。

```json
{
  "traceEvents": [
    { "name": "Allocate", "ph": "X", "pid": 1, "tid": 1, "ts": 0, "dur": 10,
      "args": { "address": "0x0000ABCD", "defines": "buffer-1" } },
    { "name": "Read buffer", "ph": "X", "pid": 1, "tid": 2, "ts": 20, "dur": 5,
      "args": { "ptr": "0xabcd", "uses": ["buffer-1"] } }
  ]
}
```

**相同位址只代表比對線索。** 本版不推論物件生命週期、記憶體範圍重疊或隱含的 define/use。不同程序可能有相同虛擬位址，記憶體也可能重用，請搭配 PID、時間及原始資料判斷。明確 `defines` / `uses` 保留角色；Chrome `s/t/f` 依 category、scope 與 ID 比對。

大於 JavaScript 安全整數範圍的 address / ID 請以字串表示；原始 JSON 可完整複製，但以數字記錄的超大整數在物件解讀時可能失真。每事件最多索引 32 個關聯鍵，巢狀掃描至 6 層，每次顯示最多 64 筆候選、最多繪製 16 條連線。這些限制不截斷儲存的原始事件。

## 大檔架構

`File.stream → TextDecoderStream → Worker 串流 parser → OPFS 原始事件 / 固定寬度索引 / 關聯索引 → 視窗查詢 → Canvas`

不對整份檔案執行 `JSON.parse()`，也不把數百萬個完整事件交給 UI。事件索引為 64 bytes / 筆，按軌道以 4,096 筆排序分塊；每塊保留摘要，縮小時依解析度聚合。原始事件與 args 存磁碟，點選後才讀取。主索引待寫事件最多 16,384 筆，區塊讀取快取最多 24 塊。

**3 GB 合成資料已完成 Node 磁碟介面引擎測試：44.4 秒建索引、約 348 MB 程序 RSS、冷查詢 P95 55.9 ms。這不是瀏覽器測試。** 詳見 [測試條件與原始數據](docs/PERFORMANCE.md)，不能直接視為所有真實 trace 或瀏覽器的保證。

目前限制：單筆 JSON 資料最多 32 MiB，metadata 摘要共 4 MiB，最多 8,192 軌道／65,536 個摘要名稱／100,000 個未結束 B 事件。超出摘要名稱上限仍保留原始事件，但名稱搜尋覆蓋不完整。時間戳依 Chrome 格式解讀為 µs；`displayTimeUnit` 僅保留為 metadata，不改變輸入單位。逆序 trace 正確性有測試，但因分塊範圍可能重疊，查詢會讀取更多磁碟資料。

尚未支援 Perfetto protobuf、SQL、stack sampling 重建、非同步區段重建、多檔合併與精確區域統計。密集畫面顯示代表事件與聚合筆數，不是每筆事件的獨立像素；可放大或搜尋具名事件。耗時排行為 inclusive duration，不是 self time。

## 開發與測試

無套件安裝與建置步驟。Node.js 22 以上：

```sh
node server.mjs
node --test tests/*.test.mjs
node scripts/benchmark.mjs 3000000000
```

開啟 `http://127.0.0.1:4318`。效能腳本把測試快取寫入作業系統暫存區並在結束時清除，輸出到忽略的 `evidence/benchmark.json`。基準測試需約 3.2 GB 可用磁碟空間；壓縮輸入在瀏覽器中可能展開得更大。

發布腳本先跑解析／索引測試，再以 `git subtree split` 把相同來源 commit 的 `dist/` 推送至 `gh-pages`。GitHub Pages 使用分支發布；目前登入憑證不具 `workflow` scope，因此未加入自訂 Actions workflow。瀏覽器人工驗收項目另見 [驗收清單](docs/VERIFICATION.md)。

## 授權與來源

[Apache License 2.0](LICENSE)。Copyright 2026 koviankevin。Perfetto 導航程式碼的來源、著作權及改寫範圍列於 [NOTICE](NOTICE)。未包含 Perfetto 的 trace processor、WASM、標誌或 UI 圖片；本專案不隸屬 Google / Perfetto。
