# MedShop — offline medical shop software

Tauri 2 + React 19 + TypeScript + SQLite. Runs fully offline on Windows.
**Prototype v1**: every daily feature of a retail pharmacy at a basic, working level.

## Windows पर setup (एक बार)

1. **Node.js 22 LTS**, **Rust** (rustup), **Microsoft C++ Build Tools** ("Desktop development with C++") install करें। WebView2 Windows 10/11 में पहले से होता है।
2. Project folder में:

```bash
npm install
npm run tauri dev     # development में app खोलें
npm run tauri build   # दुकान के लिए installer: src-tauri/target/release/bundle/ में .msi और .exe
```

## दुकान में रोज़ का काम

| काम | कहाँ | Shortcut |
| --- | --- | --- |
| बिल बनाना | नया बिल | **F2** → दवा टाइप करें → Enter → Tab से पैक / खुली / छूट → **F10** सेव + प्रिंट |
| सप्लायर का बिल डालना | खरीद एंट्री | **F3** → सप्लायर, बिल नं. → दवा जोड़ें → Enter से बैच, एक्सपायरी, पैक, फ़्री, रेट, MRP → **Ctrl+S** |
| दवा खोजना / स्टॉक देखना | स्टॉक | **F6** (हर screen पर **F4** = खोज) |
| एक्सपायरी देखना, वापस भेजना | एक्सपायरी अलर्ट | **F7** → चुनें → सप्लायर को वापस / राइट-ऑफ़ |
| दिन का हिसाब, GST, H1 रजिस्टर | रिपोर्ट | **F8** → प्रिंट या Excel |
| दुकान की जानकारी, बैकअप | सेटिंग्स | **F9** |
| पिछले बिल, वापसी, रद्द | होम → बिल | बिल खोलें → दवा वापसी / बिल रद्द |
| उधार वसूली, सप्लायर भुगतान | होम → ग्राहक / सप्लायर | नाम चुनें → रकम → पैसे मिले / भुगतान |

**Esc** = एक कदम पीछे। बिना सेव किए छोड़ने पर पहले चेतावनी आती है।

## क्या-क्या है (Prototype v1)

- **बिलिंग:** सबसे पहले एक्सपायर होने वाला बैच अपने-आप (FEFO), एक्सपायर्ड बैच कभी नहीं; स्ट्रिप + खुली गोलियाँ; लाइन या पूरे बिल पर छूट; MRP से ज़्यादा रेट नहीं; नकद / UPI / कार्ड / उधार; ग्राहक मोबाइल से खोजें; मिले पैसे → वापसी।
- **H1 / X / NDPS:** डॉक्टर और मरीज़ की जानकारी के बिना बिल सेव नहीं होता; शेड्यूल रजिस्टर अपने-आप भरता है।
- **बिल प्रिंट:** थर्मल 58 / 80 mm या A5 / A4; दुकान, GSTIN, ड्रग लाइसेंस, बैच + एक्सपायरी, CGST / SGST, Rx जानकारी, फ़ार्मासिस्ट।
- **बिल नंबर:** S/2026-27/000001, हर 1 अप्रैल से फिर शुरू; दो बिल कभी एक नंबर नहीं पा सकते।
- **वापसी और रद्द:** जितना बेचा उससे ज़्यादा वापस नहीं (database ख़ुद रोकता है); रद्द करने पर स्टॉक और उधार वापस।
- **खरीद:** फ़्री माल, छूट, GST; पिछली खरीद का रेट दिखता है और 10% से ज़्यादा फ़र्क़ पर चेतावनी; एक ही सप्लायर बिल दो बार नहीं; गलत खरीद रद्द (अगर माल बिका नहीं)।
- **स्टॉक:** बैच-वार; गिनती से ठीक करना (कारण के साथ, audit log में); कम स्टॉक की ऑर्डर लिस्ट।
- **एक्सपायरी:** एक्सपायर्ड और जल्दी एक्सपायर होने वाली; सप्लायर को वापस (क्रेडिट नोट दावा खाते में) या राइट-ऑफ़।
- **खाते:** ग्राहक का उधार, सप्लायर का बकाया, भुगतान, पिछली 100 एंट्री।
- **रिपोर्ट:** दिन का हिसाब (गल्ले में नकद सहित), बिक्री और खरीद रजिस्टर, GST सारांश (वापसी घटाकर, ITC, HSN), शेड्यूल H1 / X रजिस्टर, स्टॉक की कीमत — सब प्रिंट और Excel में।
- **बैकअप:** रोज़ अपने-आप (`Documents\MedShop Backups`, आखिरी 30); "अभी बैकअप लें"; फ़ाइल से वापस लाना (पहले मौजूदा डेटा का बैकअप); "नए सिरे से शुरू" (सैंपल डेटा मिटाने के लिए)।
- **Import:** Excel / CSV से दवाएँ + शुरुआती स्टॉक, सप्लायर, ग्राहक (Sprint 1)।
- **भाषा:** हिंदी, English, मराठी।

## अभी नहीं है (feedback के बाद)

User login / PIN और roles, distributor की purchase file import, barcode label print, WhatsApp बिल, एक से ज़्यादा counter (LAN), Tally export, e-invoice।

## Folder structure

```
src/
  App.tsx                 routes, settings, daily auto-backup
  app/SettingsContext     shop settings everywhere
  pages/                  Billing, Bills, BillView, Purchase, Purchases, Expiry, LowStock, Items, ItemEdit,
                          Parties (suppliers/customers + accounts), Import, Reports, Settings, Home
  components/             Form, ListTools, Print (print job), BillPrint (printed bill), Icons
  db/                     index.ts (reads), batch.ts (writes in one transaction), ops.ts / masters.ts / repo.ts (queries)
  lib/ops/                sale.ts, purchase.ts, stockOps.ts, fy.ts — business rules, no screens (+ ops.test.ts)
  lib/importer/           Excel/CSV import engine (+ importer.test.ts)
  lib/                    money.ts, stock.ts, gst.ts, csv.ts
  i18n/                   strings.ts, strings.sprint1.ts, strings.daily.ts (English / हिंदी / मराठी)
src-tauri/
  migrations/001…003      database schema; never edit an old file, add a new one
  src/batch.rs            run_batch: many statements in one transaction
  src/backup.rs           backup (VACUUM INTO), auto-backup, restore, reset
templates/                import templates + sample files
```

## Data rules (इन्हें कभी न तोड़ें)

- **पैसे integer paise में** (₹34.10 = 3410)। **Quantity सबसे छोटी unit में** (tablet / ml)। **GST basis points में** (5% = 500)।
- **Stock सिर्फ़ `stock_moves` से बदलता है**; trigger `batches.qty_units` अपडेट करता है और negative stock रोकता है।
- `stock_moves`, `schedule_register` delete नहीं होते। बिल और खरीद delete नहीं, cancel होते हैं।
- एक से ज़्यादा row वाला हर write `Batch` (Rust `run_batch`) से — या सब सेव, या कुछ नहीं।
- Schema बदलना हो तो नई migration (`004_…sql`) और `lib.rs` में जोड़ें।

## Tested

- **68 automated tests** (`npm test`): पैसे / GST, import, और billing, purchase, return, cancel, expiry, adjustment, payment, सारी reports — असली SQLite database पर तीनों migrations के साथ।
- **पूरे दिन का UI test** (Chrome में, असली SQLite पर): setup → import → खरीद → नकद / UPI / H1 / उधार बिल + प्रिंट → वापसी → रद्द → एक्सपायरी राइट-ऑफ़ → उधार वसूली → स्टॉक गिनती → सारी reports। 22/22 checks, हर बैच का स्टॉक उसकी movements के जोड़ के बराबर।
- 10,000 दवाओं पर खोज ≈ 1 ms।

Windows पर अभी जाँचना बाकी: असली printer (थर्मल / A4), backup / restore / reset (Rust commands), installer।
