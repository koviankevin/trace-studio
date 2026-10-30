# 鍵盤與無障礙驗證範圍

鍵盤操作驗收來源為 v0.10.0；下列配色補驗來源為 v0.14.1。這份紀錄描述已核對的功能與尚未驗證的範圍，不宣告完整 WCAG 認證或螢幕閱讀器相容性。

## 實際操作

- 群組可用 Enter／Space 收合；重建可見標籤後焦點仍在同一群組。釘選及已保存分頁也按穩定鍵恢復焦點。
- 軌道名稱可用 Enter／Space 調整高度，單擊及原有雙擊仍可用。同一次雙擊不會因標籤移位而切換兩次。
- 時間軸取得焦點後，Enter 選取第一個可見代表事件；聚合資料仍需放大查看。逗號／句號讀取同軌道前後事件。搜尋及分析結果可用鍵盤跳回時間軸。
- 選取狀態有簡短的 polite status，含名稱、時間與軌道；不將整份 JSON 放進即時播報。Q 關閉詳情或 Esc 清除選取後保留時間軸焦點。
- Ctrl Shift P 指令選單以方向鍵更新目前項目；DOM 焦點保留輸入框，aria-activedescendant／aria-selected 對應一筆選項。清單獨立捲動，目前項目保持可見。
- 說明、指令、快取及載入視窗有可讀名稱；一般 Tab／Shift Tab 在模態視窗內循環，Ctrl／Meta 瀏覽器組合鍵不攔截。Esc 保留既有關閉／取消語意。
- 提供跳至工作區連結；收合側欄的快捷鍵與快取圖示仍有完整名稱。快取開啟／清除按鈕的名稱包含檔案，主題按鈕暴露目前狀態。

## 可讀性

基本 muted 文字在 bg、panel、panel-alt、hover 表面，以兩種主題計算至少 4.5:1；內建事件類別及其他配色使用黑／白文字，亦經同門檻核對。Canvas 入口測試另外核對實際文字色。這只涵蓋列明的基本配色，未證明整頁、所有 hardcoded／hover 色、自訂擴充或圖片中的文字均通過。

焦點框按主題變色，群組焦點框內縮以避免被列邊界裁切；800×600 的指令項目保持在視窗內，沒有水平溢出。

## v0.14.1 配色補驗

正式 v0.14.0 的實際 DOM 配色量測發現：亮色刻度標題 2.91:1、底部資訊 2.92:1、未釘選按鈕 1.79:1；深色未選取導覽 2.61:1、主要開啟按鈕 3.24:1。改用現有 muted 主題色，深色主要按鈕則使用深色文字。六個具體 selector 在兩種主題、1280×720 及 800×600 重新讀取 computed style，最低為 5.01:1；兩種尺寸的 clientWidth 與 scrollWidth 相等。沒有修改字級、列高、事件分類色或手勢程式。

[前後數據與來源雜湊](readability-browser-2026-10-30-v0.14.1.json)。這是所列控制項的預設狀態量測，不包含所有 hover、整頁文字或實際螢幕閱讀器。

## 依據與限制

- [WAI APG 鍵盤焦點](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)：互動控制項重建後須保有可理解的鍵盤位置。
- [WAI APG Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)：指令清單的輸入焦點與目前項目語意。
- [WAI APG Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)：模態 Tab 邊界與返回位置。
- [WCAG 2.2 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)：一般文字使用 4.5:1 的計算門檻。
- [Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)：狀態更新不強制移動使用者焦點。

已核對 Node 的焦點邊界／實際 app 入口，以及 Windows 內嵌 Chromium 156 的真實按鍵、DOM、AX 與畫面。完整 NVDA／Narrator 語音、獨立 Chrome／Edge、200%／400% 放大、高對比、所有表格與圖表的無障礙仍待驗證；不能用 DOM 屬性存在代替。

具體幾何與操作紀錄：[keyboard-browser-2026-10-30-v0.10.0.json](keyboard-browser-2026-10-30-v0.10.0.json)。
