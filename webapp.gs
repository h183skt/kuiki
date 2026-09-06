/**
 * 区域訪問記録ウェブアプリ - サーバー側スクリプト
 * 
 * Googleログインなし（シークレットウィンドウやiPhone）でも動作するようにしつつ、
 * 個別マンションシートの個人情報アクセス制限（Googleドライブ共有設定）を維持するため、
 * 「登録されたGoogleメールアドレスの入力」による認証方式（v1.8.0）を採用しています。
 * 入力されたメールアドレスが「キー管理」シートに登録されている場合のみログインを許可します。
 */

// 設定項目
const WEBAPP = {
  TITLE: '区域訪問記録マップ',
  VERSION: 'v1.11.18',
  ICON_URL: 'https://5d5f3d7a.png-cdu.pages.dev/area_door_pin_icon_180.png',
  SHEET_NAME: '統合',
  CACHE_SHEET: '座標キャッシュ',
  DEFAULT_COLOR: '#5f6368',

  // 建物種別によるマーカーカラー
  TYPE_COLORS: {
    '単身': '#1a73e8',  // 青
    '世帯': '#d93025',  // 赤
    '混在': '#f9ab00',  // オレンジ
    'その他': '#9aa0a6'  // グレー
  },

  // 訪問結果のステータス定義
  REC_RESULTS: ['会えた', '留守', '空室', '投函のみ', '予約'],
  REC_PERIODS: ['1〜3月', '4〜6月', '7〜9月', '10〜12月'],

  // カラム番号定義（1から開始）
  COL_AREA: 1,  // A列: エリア
  COL_MAP: 2,   // B列: Map
  COL_NAME: 3,  // C列: マンション名
  COL_TYPE: 4,  // D列: 住居形態
  COL_ADDR: 5,  // E列: 住所
  COL_MEMO: 6,  // F列: 備考
  COL_ID: 7,    // G列: ID
  COL_STATE: 8, // H列: 拒否
  COL_CELL: 9,  // I列: シート
  COL_URL: 10,  // J列: URL

  // 訪問記録シート内の座標・パーサー設定
  REC_DATA_START_ROW: 6,
  REC_ROOM_COL: 1,
  REC_PREV_COL: 2,
  REC_FIRST_VISIT_COL: 3,
  REC_VISIT_COLS: 12
};

/* ============================================================
 * 訪問記録 読み取り
 * ============================================================ */

function getVisitRecords(url) {
  const email = Session.getActiveUser().getEmail();
  try {
    if (!isValidAccess_(email)) {
      return {
        ok: false,
        error: 'このメールアドレス（' + (email || '不明') + '）は登録されていません。管理者に登録をご依頼ください。'
      };
    }

    if (!isAllowedSheetUrl_(url)) {
      return {
        ok: false,
        error: 'このシートは統合リストに登録されていないため開けません。'
      };
    }

    const ids = parseSheetUrl_(url);
    if (!ids) {
      return {
        ok: false,
        error: 'URLからシートを特定できませんでした。'
      };
    }

    // Google認証 (USER_ACCESSING) のため、hasPermissionToSheet_() による総当たりループは不要です。
    // openSheetByUrl_() でスプレッドシートを開く際、権限がなければ自動でエラーが発生し、
    // catch ブロックの friendlySheetAccessError_() で検知されて適切なメッセージになります。

    const sheet = openSheetByUrl_(url);
    if (!sheet) {
      return {
        ok: false,
        error: '指定されたスプレッドシートを開けませんでした。URLが正しいかご確認ください。'
      };
    }

    const lastRow = sheet.getLastRow();
    const start = WEBAPP.REC_DATA_START_ROW;

    if (lastRow < start) {
      return {
        ok: true,
        rooms: [],
        sheetName: sheet.getName(),
        periods: WEBAPP.REC_PERIODS,
        results: WEBAPP.REC_RESULTS
      };
    }

    const numRows = lastRow - start + 1;
    const firstCol = WEBAPP.REC_ROOM_COL;
    const numCols = WEBAPP.REC_FIRST_VISIT_COL - 1 + WEBAPP.REC_VISIT_COLS;
    const disp = sheet.getRange(start, firstCol, numRows, numCols).getDisplayValues();

    const rooms = [];

    // 2行ずつループを回して 部屋・前回の記録・訪問セルを取得
    for (let i = 0; i < disp.length; i += 2) {
      const topRow = disp[i];
      const botRow = (i + 1 < disp.length) ? disp[i + 1] : [];

      const room = String(topRow[WEBAPP.REC_ROOM_COL - 1] || '').trim();
      if (!room) continue;

      const prev = String(topRow[WEBAPP.REC_PREV_COL - 1] || '').trim();
      const cells = [];

      for (let c = 0; c < WEBAPP.REC_VISIT_COLS; c++) {
        const col = (WEBAPP.REC_FIRST_VISIT_COL - 1) + c;
        const result = String(topRow[col] || '').trim();
        const date = String((botRow[col] !== undefined ? botRow[col] : '') || '').trim();
        cells.push({
          result: result,
          date: date
        });
      }

      rooms.push({
        room: room,
        prev: prev,
        cells: cells,
        rowTop: start + i
      });
    }

    return {
      ok: true,
      sheetName: sheet.getName(),
      rooms: rooms,
      periods: WEBAPP.REC_PERIODS,
      results: WEBAPP.REC_RESULTS
    };

  } catch (e) {
    return {
      ok: false,
      error: friendlySheetAccessError_(e, 'read')
    };
  }
}

/* ============================================================
 * 訪問記録 書き込み
 * ============================================================ */

function saveVisitRecord(p) {
  p = p || {};
  const email = Session.getActiveUser().getEmail();
  
  if (!isValidAccess_(email)) {
    return {
      ok: false,
      error: 'このメールアドレス（' + (email || '不明') + '）は登録されていません。管理者に登録をご依頼ください。'
    };
  }

  const lock = LockService.getDocumentLock();

  try {
    lock.waitLock(15000);
  } catch (e) {
    return {
      ok: false,
      error: '他の処理が実行中です。少し待って再度お試しください。'
    };
  }

  try {
    if (!isAllowedSheetUrl_(p.url)) {
      return {
        ok: false,
        error: 'このシートは統合リストに登録されていないため保存できません。'
      };
    }

    const ids = parseSheetUrl_(p.url);
    if (!ids) {
      return {
        ok: false,
        error: 'URLからシートを特定できませんでした。'
      };
    }

    // Google認証 (USER_ACCESSING) のため、hasPermissionToSheet_() は不要。
    // openSheetByUrl_() でエラーが発生すれば catch ブロックで処理されます。

    const sheet = openSheetByUrl_(p.url);
    if (!sheet) {
      return {
        ok: false,
        error: '指定されたスプレッドシートを開けませんでした。URLが正しいかご確認ください。'
      };
    }

    const rowTop = Number(p.rowTop);
    const cellIndex = Number(p.cellIndex);

    if (!Number.isInteger(rowTop) || rowTop < WEBAPP.REC_DATA_START_ROW) {
      return {
        ok: false,
        error: '不正な行位置が指定されました。'
      };
    }

    if ((rowTop - WEBAPP.REC_DATA_START_ROW) % 2 !== 0) {
      return {
        ok: false,
        error: '不正な行位置が指定されました。'
      };
    }

    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= WEBAPP.REC_VISIT_COLS) {
      return {
        ok: false,
        error: '不正なセル位置が指定されました。'
      };
    }

    const lastRow = sheet.getLastRow();
    if (rowTop + 1 > lastRow) {
      return {
        ok: false,
        error: '指定された部屋行がシート範囲外です。'
      };
    }

    const resultRow = rowTop;
    const dateRow = rowTop + 1;
    const col = WEBAPP.REC_FIRST_VISIT_COL + cellIndex;

    const roomLabel = String(sheet.getRange(resultRow, WEBAPP.REC_ROOM_COL).getDisplayValue() || '').trim();
    if (!roomLabel) {
      return {
        ok: false,
        error: '指定された行に部屋番号が見つかりません。'
      };
    }

    const newResult = String(p.result || '').trim();
    const newDate = String(p.date || '').trim();

    if (newResult && WEBAPP.REC_RESULTS.indexOf(newResult) === -1) {
      return {
        ok: false,
        error: '不正な結果が指定されました。'
      };
    }

    const curResult = String(sheet.getRange(resultRow, col).getDisplayValue() || '').trim();
    const curDate = String(sheet.getRange(dateRow, col).getDisplayValue() || '').trim();

    const expR = String(p.expectResult || '').trim();
    const expD = String(p.expectDate || '').trim();

    if (curResult !== expR || curDate !== expD) {
      return {
        conflict: true,
        current: {
          result: curResult,
          date: curDate
        }
      };
    }

    sheet.getRange(resultRow, col).setValue(newResult);
    sheet.getRange(dateRow, col).setNumberFormat('@').setValue(newDate);

    SpreadsheetApp.flush();

    return {
      ok: true,
      saved: {
        result: newResult,
        date: newDate
      }
    };
  } catch (e) {
    return {
      ok: false,
      error: friendlySheetAccessError_(e, 'write')
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * 日付処理
 * ============================================================ */

function todayLabel_() {
  return formatDateLabel_(new Date());
}

function formatDateLabel_(d) {
  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';

  const year = Number(Utilities.formatDate(d, tz, 'yyyy'));
  const month = Number(Utilities.formatDate(d, tz, 'M'));
  const day = Number(Utilities.formatDate(d, tz, 'd'));

  const wdays = ['日', '月', '火', '水', '木', '金', '土'];
  const dow = new Date(year, month - 1, day).getDay();

  return month + '/' + day + ' (' + wdays[dow] + ')';
}

function getTodayLabel() {
  return todayLabel_();
}

/* ============================================================
 * アクセスキー認証とスプレッドシート権限チェック
 * ============================================================ */

function ensureKeyManagementSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('キー管理');
  
  if (!sh) {
    sh = ss.insertSheet('キー管理');
    sh.getRange(1, 1, 1, 2).setValues([['許可するメールアドレス', '備考']]);
    sh.getRange(2, 1, 1, 2).setValues([['admin@example.com', 'デモメンバー']]);
    sh.getRange(3, 1, 1, 2).setValues([['jw.noborito@gmail.com', '登戸会衆']]);
    SpreadsheetApp.flush();
  } else {
    // 既存のシートがある場合、ヘッダーが古い構成（有効なアクセスキー）のままであれば補正する
    const headerVal = String(sh.getRange(1, 1).getValue()).trim();
    if (headerVal === '有効なアクセスキー') {
      sh.getRange(1, 1).setValue('許可するメールアドレス');
      SpreadsheetApp.flush();
    }
  }
  return sh;
}

function isValidAccess_(email) {
  if (!email) return false;
  const checkEmail = email.trim().toLowerCase();
  
  const sh = ensureKeyManagementSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  
  // A列（許可するメールアドレス）をチェック
  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowEmail = String(values[i][0]).trim().toLowerCase();
    
    if (rowEmail === checkEmail && checkEmail !== '') {
      return true;
    }
  }
  return false;
}



function cleanErrorMessage_(e) {
  return String((e && (e.stack || e.message)) ? (e.stack || e.message) : e || '')
    .replace(/^(Exception|Error):\s*/, '')
    .trim();
}

function friendlySheetAccessError_(e, mode) {
  const msg = String(e);
  if (msg.indexOf('権限') !== -1 || msg.toLowerCase().indexOf('permission') !== -1 || msg.toLowerCase().indexOf('access') !== -1) {
    return '個別スプレッドシートの閲覧・編集権限がありません。Googleドライブ上でアクセス権が共有されているか管理者に確認してください。';
  }
  return (mode === 'read' ? '読み込み' : '保存') + '中にエラーが発生しました: ' + cleanErrorMessage_(e);
}

/* ============================================================
 * 内部ユーティリティ & データベース
 * ============================================================ */

function isAllowedSheetUrl_(url) {
  if (!url) return false;
  const key = parseSheetUrl_(url);
  if (!key) return false;

  const allowed = getAllowedSheetKeys_();
  return allowed[key.fileId] === true;
}

function getAllowedSheetKeys_() {
  const cacheKey = 'allowed_sheet_keys_v3';
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WEBAPP.SHEET_NAME);
  const result = {};

  if (sh && sh.getLastRow() >= 2) {
    const urls = sh.getRange(2, WEBAPP.COL_URL, sh.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < urls.length; i++) {
      const u = String(urls[i][0]).trim();
      const ids = parseSheetUrl_(u);
      if (ids) {
        result[ids.fileId] = true;
      }
    }
  }

  cache.put(cacheKey, JSON.stringify(result), 1800); // 30分キャッシュ
  return result;
}

function openSheetByUrl_(url) {
  const ids = parseSheetUrl_(url);
  if (!ids) return null;

  const ss = SpreadsheetApp.openById(ids.fileId);
  let sheet = null;

  if (ids.gid !== null) {
    const all = ss.getSheets();

    for (let i = 0; i < all.length; i++) {
      if (String(all[i].getSheetId()) === String(ids.gid)) {
        sheet = all[i];
        break;
      }
    }
  }

  if (!sheet) {
    sheet = ss.getSheets()[0];
  }

  return sheet;
}

function parseSheetUrl_(url) {
  if (!url) return null;

  const idM = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!idM) return null;

  const gidM = String(url).match(/[#?&]gid=(\d+)/);

  return {
    fileId: idM[1],
    gid: gidM ? gidM[1] : null
  };
}

/* ============================================================
 * ウェブアプリ本体
 * ============================================================ */

function doGet() {
  try {
    return doGet_();
  } catch (e) {
    const msg = cleanErrorMessage_(e);
    const body = 'エラーが発生しました: ' + msg;
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:-apple-system,"Hiragino Sans",sans-serif;padding:32px 16px;color:#202124;}' +
      'p{font-size:15px;line-height:1.7;}</style></head>' +
      '<body><p>' + body + '</p></body></html>'
    ).setTitle(WEBAPP.TITLE);
  }
}

function doGet_() {
  try {
    ensureKeyManagementSheet_();
  } catch (e) {
    Logger.log('キー管理シートの自動生成に失敗しました: ' + e);
  }

  const colorsJson = JSON.stringify(WEBAPP.TYPE_COLORS);
  const resultsJson = JSON.stringify(WEBAPP.REC_RESULTS);
  const webappUrl = ScriptApp.getService().getUrl();

  // 初期読み込みではマンションデータを含めず空の配列を渡します。
  // クライアント側でメールアドレス入力後に getAppData を使って非同期ロードします。
  return HtmlService.createHtmlOutput(buildHtml_('[]', colorsJson, resultsJson, webappUrl, ''))
    .setTitle(WEBAPP.TITLE)
    .setFaviconUrl(WEBAPP.ICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * メールアドレスを検証し、許可された全マンションデータとユーザー情報を取得する
 */
function getAppData() {
  const email = Session.getActiveUser().getEmail();
  if (!isValidAccess_(email)) {
    return { ok: false, email: email, error: 'あなたのGoogleアカウント（' + (email || '不明') + '）は登録されていません。管理者に登録をご依頼ください。' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(WEBAPP.SHEET_NAME);
    if (!sh) {
      return { ok: false, error: 'シート「' + WEBAPP.SHEET_NAME + '」が見つかりません。' };
    }

    const coords = {};
    const cache = ss.getSheetByName(WEBAPP.CACHE_SHEET);
    if (cache && cache.getLastRow() >= 2) {
      cache.getRange(2, 1, cache.getLastRow() - 1, 4).getValues().forEach(r => {
        if (r[3] === 'OK') {
          coords[r[0]] = [Number(r[1]), Number(r[2])];
        }
      });
    }

    const lastRow = sh.getLastRow();
    const rows = [];

    if (lastRow >= 2) {
      const numRows = lastRow - 1;
      const display = sh.getRange(2, 1, numRows, WEBAPP.COL_URL).getDisplayValues();
      const formulas = sh.getRange(2, 1, numRows, WEBAPP.COL_URL).getFormulas();

      for (let r = 0; r < numRows; r++) {
        const name = display[r][WEBAPP.COL_NAME - 1];
        if (!name) continue;

        const addr = display[r][WEBAPP.COL_ADDR - 1];
        const c = coords[addr] || null;

        rows.push({
          area: display[r][WEBAPP.COL_AREA - 1],
          name: name,
          type: display[r][WEBAPP.COL_TYPE - 1],
          addr: addr,
          state: display[r][WEBAPP.COL_STATE - 1],
          url: display[r][WEBAPP.COL_URL - 1],
          map: urlFromFormula_(formulas[r][WEBAPP.COL_MAP - 1]),
          lat: c ? c[0] : null,
          lng: c ? c[1] : null,
        });
      }
    }

    return {
      ok: true,
      data: rows,
      name: email.trim(),
      email: email.trim().toLowerCase()
    };
  } catch (e) {
    return { ok: false, error: 'データの読み込みに失敗しました: ' + cleanErrorMessage_(e) };
  }
}

/**
 * 現在デプロイされているWebアプリのバージョンを返す。
 * クライアントが起動時に読み込んだバージョン（CURRENT_VERSION）と比較し、
 * 更新の有無を判定するために使う。
 */
function getServerVersion() {
  return WEBAPP.VERSION;
}

function urlFromFormula_(formula) {
  if (!formula) return '';

  const m = String(formula).match(/^=HYPERLINK\(\s*"([^"]+)"/i);
  return m ? m[1] : '';
}

function buildHtml_(dataJson, colorsJson, resultsJson, webappUrl, userEmail) {
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="apple-mobile-web-app-capable" content="yes">' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">' +
    '<meta name="apple-mobile-web-app-title" content="' + WEBAPP.TITLE + '">' +
    '<link rel="apple-touch-icon" href="' + WEBAPP.ICON_URL + '">' +
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">' +
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>' +
    '<style>' +
    ':root{--accent:#1a73e8;--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--text:#202124;--sub:#5f6368;--green:#34a853;}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}' +
    'html,body{margin:0;height:100%;}' +
    'body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;}' +
    'header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 12px;position:relative;z-index:1100;}' +
    '.topbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;}' +
    'h1{font-size:16px;margin:0;flex:1;}' +
    '.ver{font-size:11px;color:var(--sub);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:2px 7px;margin-right:4px;white-space:nowrap;cursor:pointer;user-select:none;}' +
    '.ver.update-available{color:#fff!important;background:#d93025!important;border-color:#d93025!important;font-weight:700;animation:pulse-red 2s infinite;}' +
    '.ver:active{opacity:0.6;}' +
    '@keyframes pulse-red{0%,100%{transform:scale(1);}50%{transform:scale(1.06);}}' +
    '#versionModal{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);z-index:3500;display:none;align-items:center;justify-content:center;padding:16px;}' +
    '.vmodal-box{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25);width:100%;max-width:400px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;}' +
    '.vmodal-head{padding:12px 16px 10px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}' +
    '.vmodal-title{font-size:16px;font-weight:800;color:var(--text);margin:0;}' +
    '.vmodal-status{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;margin-top:4px;display:inline-block;}' +
    '.vmodal-status.is-latest{background:#e6f4ea;color:#137333;}' +
    '.vmodal-status.has-update{background:#fce8e6;color:#c5221f;}' +
    '.vmodal-body{padding:12px 16px;overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;flex:1;background:var(--bg);margin:8px 12px;border-radius:8px;border:1px solid var(--line);max-height:50vh;}' +
    '.vmodal-foot{padding:10px 16px 14px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;background:var(--card);}' +
    '.vmodal-btn{font-size:13px;font-weight:700;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer;}' +
    '.vmodal-btn:active{opacity:0.7;}' +
    '.vmodal-btn-update{background:#d93025;border-color:#d93025;color:#fff;display:none;}' +
    '.vmodal-btn-update:active{background:#b31412;}' +
    '.toggle{display:flex;border:1px solid var(--accent);border-radius:8px;overflow:hidden;}' +
    '.toggle button{font-size:13px;padding:6px 14px;border:0;background:var(--card);color:var(--accent);}' +
    '.toggle button.on{background:var(--accent);color:#fff;}' +
    '#q{width:100%;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);}' +
    '#count{font-size:12px;color:var(--sub);margin:6px 2px 0;}' +
    '#list{flex:1;overflow-y:auto;padding:8px 12px 40px;}' +
    '#mapwrap{flex:1;display:none;position:relative;}' +
    '#map{position:absolute;inset:0;}' +
    '#locate{position:absolute;right:12px;bottom:24px;z-index:1000;font-size:14px;font-weight:600;padding:10px 14px;border-radius:24px;border:1px solid var(--line);background:var(--card);color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,.2);}' +
    '#locate.on{background:var(--accent);border-color:var(--accent);color:#fff;}' +
    '.ghead{font-size:13px;font-weight:700;color:var(--sub);margin:14px 2px 6px;}' +
    '.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;}' +
    '.info{flex:1;min-width:0;}' +
    '.name{font-size:16px;font-weight:600;}' +
    '.name a{color:var(--accent);text-decoration:none;cursor:pointer;}' +
    '.meta{font-size:12.5px;color:var(--sub);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;}' +
    '.badge{background:#e8f0fe;color:var(--accent);border-radius:6px;padding:1px 7px;font-weight:600;}' +
    '.maplink{flex:0 0 auto;font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--accent);border-radius:8px;padding:6px 10px;}' +
    '.pop .pname{font-size:15px;font-weight:700;margin-bottom:2px;}' +
    '.pop .paddr{font-size:12px;color:var(--sub);}' +
    '.loading-logo{width:144px;height:144px;margin-bottom:12px;}' +
    '.loading-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;color:var(--sub);}' +
    '.loading-wrap p{font-size:15px;font-weight:600;margin:12px 0 0;}' +
    '.spinner{width:32px;height:32px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;}' +
    '@keyframes spin{to{transform:rotate(360deg);}}' +
    '.rectable{width:100%;border-collapse:collapse;margin-top:4px;font-size:13px;border:1px solid var(--line);}' +
    '.dirrow{display:flex;gap:5px;margin-top:7px;}' +
    '.dirlink{flex:1;text-align:center;font-size:13px;font-weight:700;background:var(--green);color:#fff;border-radius:8px;padding:10px 4px;text-decoration:none;white-space:nowrap;}' +
    '.pop .actionrow{display:flex;gap:5px;margin-top:6px;}' +
    '.pop .recbtn{flex:2;text-align:center;font-size:13px;font-weight:700;background:var(--accent);color:#fff;border-radius:8px;padding:10px;cursor:pointer;white-space:nowrap;}' +
    '.pop .recbtn.disabled{background:var(--sub);opacity:.5;cursor:not-allowed;pointer-events:none;}' +
    '.pop .closebtn{flex:1;text-align:center;font-size:13px;font-weight:700;background:var(--sub);color:#fff;border-radius:8px;padding:10px;cursor:pointer;white-space:nowrap;}' +
    '.pop .pbadge{display:inline-block;font-size:11px;background:#e8f0fe;color:var(--accent);border-radius:5px;padding:0 6px;font-weight:600;margin-bottom:3px;}' +
    '.me-wrap{position:relative;width:36px;height:40px;}' +
    '.me-pulse{position:absolute;left:50%;bottom:2px;transform:translateX(-50%);width:14px;height:14px;border-radius:50%;background:rgba(52,168,83,.9);animation:mepulse 1.6s ease-out infinite;}' +
    '@keyframes mepulse{0%{box-shadow:0 0 0 0 rgba(52,168,83,.6);}100%{box-shadow:0 0 0 22px rgba(52,168,83,0);}}' +
    '.me-emoji{position:absolute;left:50%;bottom:0;transform:translateX(-50%);font-size:34px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));}' +
    '.refuse-pin{width:20px;height:20px;border-radius:50%;background:#202124;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);color:#fff;font-weight:800;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;}' +
    '.empty{text-align:center;color:var(--sub);padding:40px 0;}' +
    '#rec{position:fixed;inset:0;background:var(--card);z-index:2000;display:none;}' +
    '#recinner{position:absolute;inset:0;background:var(--card);padding:12px 0 0 0;display:flex;flex-direction:column;max-height:100vh;}' +
    '#rechead{display:flex;align-items:center;margin-bottom:8px;padding:0 12px;}' +
    '#rectitle{font-size:17px;font-weight:800;color:var(--accent);margin:0;flex:1;}' +
    '#recclose{font-size:14px;font-weight:600;color:var(--accent);background:none;border:1px solid var(--accent);border-radius:8px;padding:6px 12px;}' +
    '#recbody{flex:1;overflow:auto;padding:0 0 20px 0;}' +
    '.rectable th,.rectable td{border:1px solid var(--line);padding:4px 6px;text-align:center;}' +
    '.rectable thead th{background:#0b8043;color:#fff;position:sticky;top:0;z-index:2;}' +
    '.rectable thead th.curp{background:var(--accent);}' +
    '.rectable .rm{position:sticky;left:0;background:#0b8043;color:#fff;font-weight:700;z-index:1;}' +
    '.rectable td.cell{cursor:pointer;min-width:62px;}' +
    '.rectable td.cell:active{background:#fff3cd;}' +
    '.rectable .res{font-weight:600;min-height:14px;}' +
    '.rectable .date{color:var(--sub);font-size:11px;min-height:12px;}' +
    '.rectable .filled{background:#e8f0fe;}' +
    '.rectable td.active-cell{background:#fff9c4;}' +
    '.rectable td.past-cell{background:#dadce0;color:#70757a;}' +
    '.recnote{font-size:12px;color:var(--sub);margin:0 0 8px;}' +
    '#edit{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:3000;display:none;}' +
    '#editbox{position:absolute;left:0;right:0;bottom:0;background:var(--card);border-radius:16px 16px 0 0;padding:14px 16px 22px;max-height:calc(100vh - 24px);overflow:auto;}' +
    '.edithead{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px;}' +
    '#edittitle{font-size:18px;font-weight:800;line-height:1.35;color:#d93025;margin:0;flex:1;}' +
    '#editclose{flex:0 0 auto;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;color:var(--sub);background:none;border:1px solid var(--line);border-radius:999px;padding:0;}' +
    '.resrow{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}' +
    '.resbtn{flex:1 0 28%;font-size:14px;padding:10px 6px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);}' +
    '.resbtn.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700;}' +
    '.resbtn.clear{background:#fff;color:#d93025;border-color:#d93025;}' +
    '.resbtn.clear.on{background:#d93025;border-color:#d93025;color:#fff;}' +
    '.daterow{display:flex;align-items:center;gap:8px;margin-bottom:14px;}' +
    '.daterow label{font-size:13px;color:var(--sub);}' +
    '#editdate{flex:1;font-size:16px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;}' +
    '.todaywrap{position:relative;flex:0 0 auto;display:flex;}' +
    '#today{font-size:12px;padding:8px 10px;border:1px solid var(--accent);color:var(--accent);background:none;border-radius:8px;pointer-events:none;}' +
    '#editdatepick{position:absolute;inset:0;opacity:0;z-index:1;cursor:pointer;}' +
    '.btnrow{display:flex;gap:8px;}' +
    '.btnrow button{flex:1;font-size:15px;font-weight:700;padding:12px;border-radius:10px;border:0;}' +
    '#save{background:var(--accent);color:#fff;}' +
    '.leaflet-control-layers{border-radius:10px!important;box-shadow:0 2px 10px rgba(0,0,0,.15)!important;border:1px solid var(--line)!important;font-size:13px!important;}' +
    '.leaflet-control-layers-expanded{padding:10px 14px!important;line-height:1.7!important;max-height:75vh;overflow-y:auto;background:var(--card)!important;color:var(--text)!important;}' +
    '.leaflet-control-layers-base label{margin:3px 0!important;cursor:pointer;display:flex;align-items:center;gap:6px;}' +
    '.leaflet-control-layers-base input{margin:0!important;cursor:pointer;}' +
    '.pin-dropdown-btn{font-size:12px;font-weight:700;padding:0 8px;height:30px;border:1.5px solid var(--accent);border-radius:8px;background:var(--card);color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.06);}' +
    '.pin-dropdown-btn.pins-hidden{border-color:#d93025;color:#d93025;background:#fce8e6;}' +
    '.pin-dropdown-menu{position:absolute;top:34px;left:0;z-index:2100;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.25);padding:8px;min-width:210px;max-width:260px;display:flex;flex-direction:column;gap:6px;}' +
    '.pdm-head{display:flex;align-items:center;justify-content:space-between;gap:4px;padding-bottom:6px;border-bottom:1px solid var(--line);}' +
    '.pdm-btn-sm{font-size:11px;font-weight:700;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer;white-space:nowrap;}' +
    '.pdm-btn-sm.pdm-primary{background:var(--accent);color:#fff;border-color:var(--accent);}' +
    '.pdm-btn-sm.pdm-danger{color:#d93025;border-color:#fce8e6;background:#fce8e6;}' +
    '.pdm-list{overflow-y:auto;-webkit-overflow-scrolling:touch;max-height:220px;display:flex;flex-direction:column;gap:2px;}' +
    '.pdm-item{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:6px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--text);user-select:none;}' +
    '.pdm-item:hover{background:var(--bg);}' +
    '.pdm-item input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);cursor:pointer;margin:0;}' +
    '#btnPortal:active{background:var(--accent)!important;color:#fff!important;}' +
    '.leaflet-control-layers-overlays label{margin:4px 0!important;cursor:pointer;display:flex;align-items:center;gap:6px;font-weight:600;}' +
    '.leaflet-control-layers-overlays input{margin:0!important;cursor:pointer;}' +
    '.leaflet-control-layers-separator{border-top:1px solid var(--line)!important;margin:8px 0!important;}' +
    '#overlayBar{position:absolute;top:10px;left:10px;z-index:1000;background:rgba(255,255,255,0.96);backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:12px;padding:6px 12px;box-shadow:0 3px 12px rgba(0,0,0,.15);display:flex;align-items:center;gap:10px;}' +
    '.obar-row{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;}' +
    '#overlayOpacity{width:90px;height:24px;accent-color:var(--accent);cursor:pointer;}' +
    '#btnAdjustMode{font-size:13px;padding:6px 12px;min-height:36px;border:1.5px solid var(--accent);border-radius:8px;background:var(--card);color:var(--accent);cursor:pointer;white-space:nowrap;font-weight:700;}' +
    '#btnAdjustMode.on{background:var(--accent);color:#fff;border-color:var(--accent);}' +
    '#adjustModal{position:fixed;top:0;left:0;right:0;z-index:2005;background:rgba(255,255,255,0.96);backdrop-filter:blur(10px);border-bottom:2px solid var(--accent);box-shadow:0 4px 16px rgba(0,0,0,.2);padding:6px 10px 8px;max-height:85vh;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:6px;}' +
    '.adj-row1{display:flex;align-items:center;justify-content:space-between;gap:6px;}' +
    '.adj-row2{display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
    '.adj-dpad{display:grid;grid-template-columns:repeat(3, 46px);grid-template-rows:repeat(2, 40px);gap:4px;flex-shrink:0;}' +
    '.adj-actions{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:40px 38px;gap:4px;min-width:160px;}' +
    '.adj-large-btn{padding:0 4px;font-size:12.5px;font-weight:700;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-webkit-touch-callout:none;box-shadow:0 1px 4px rgba(0,0,0,.08);}' +
    '.adj-large-btn:active{background:var(--line);transform:scale(0.96);}' +
    '.adj-arrow{font-size:22px;font-weight:900;background:#f0f4f9;border-color:#d2e3fc;color:var(--accent);-webkit-user-select:none;user-select:none;}' +
    '.adj-size-panel{display:none;grid-template-columns:repeat(6, 1fr);gap:4px;padding-top:4px;border-top:1px dashed var(--line);}' +
    '.adj-size-panel.show{display:grid;}' +
    '.adj-btn-sm{height:32px;padding:0 2px;font-size:11px;font-weight:700;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;-webkit-user-select:none;user-select:none;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.06);}' +
    '.adj-btn-sm:active{background:var(--line);transform:scale(0.96);}' +
    '.corner-pin{width:24px;height:24px;background:var(--accent);border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:move;touch-action:none;}' +
    '.leaflet-control-layers-toggle{position:relative;display:flex!important;align-items:center;justify-content:center;}' +
    '.ctrl-btn-badge{position:absolute;bottom:1px;right:1px;font-size:9px;font-weight:800;line-height:1.1;padding:1px 3px;border-radius:3px;background:var(--accent);color:#fff;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,0.3);}' +
    '.lyr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1;}' +
    '.lyr-title{font-size:12px;font-weight:800;white-space:nowrap;}' +
    '.leaflet-top{z-index:1000;}' +
    '.leaflet-top.leaflet-right{z-index:1002;}' +
    '.leaflet-control-layers-expanded{z-index:1003;}' +
    '.leaflet-control-zoom{z-index:990;}' +
    '.leaflet-control-base-map .ctrl-btn-badge{background:#1e8e3e;}' +
    '</style></head><body>' +
    '<div id="login-screen" style="position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;">' +
    '  <div style="background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;width:100%;max-width:360px;box-shadow:0 4px 16px rgba(0,0,0,0.08);display:flex;flex-direction:column;align-items:center;">' +
    '    <img src="' + WEBAPP.ICON_URL + '" style="width:72px;height:72px;margin-bottom:16px;">' +
    '    <h2 style="font-size:18px;margin:0 0 4px;font-weight:700;color:var(--text);">区域訪問記録アプリ</h2>' +
    '    <div style="font-size:12px;color:var(--sub);margin-bottom:16px;">' + WEBAPP.VERSION + '</div>' +
    '    <div id="login-loading" style="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:8px;">' +
    '      <div class="spinner"></div>' +
    '      <p style="font-size:14px;color:var(--sub);margin:0;font-weight:600;">Google認証を確認中…</p>' +
    '    </div>' +
    '    <div id="login-error-msg" style="color:#d93025;font-size:13px;margin-top:12px;text-align:center;min-height:18px;font-weight:600;width:100%;"></div>' +
    '  </div>' +
    '</div>' +
    '<div id="versionModal">' +
    '  <div class="vmodal-box">' +
    '    <div class="vmodal-head">' +
    '      <div>' +
    '        <h3 class="vmodal-title">バージョン・更新情報</h3>' +
    '        <div id="vmodalStatus" class="vmodal-status">確認中…</div>' +
    '      </div>' +
    '      <button id="vmodalCloseIcon" type="button" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--sub);line-height:1;padding:2px 6px;">✕</button>' +
    '    </div>' +
    '    <div id="vmodalBody" class="vmodal-body"></div>' +
    '    <div class="vmodal-foot">' +
    '      <button id="vmodalClose" type="button" class="vmodal-btn">閉じる</button>' +
    '      <button id="vmodalUpdate" type="button" class="vmodal-btn vmodal-btn-update">🔄 最新版に更新</button>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<header><div class="topbar"><h1 style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + WEBAPP.TITLE + '</h1>' +
    '<span class="ver" id="btnVersion" title="バージョン情報・更新履歴">' + WEBAPP.VERSION + '</span>' +
    '<button id="btnUpdate" style="display:none;font-size:11px;color:var(--accent);background:var(--card);border:1px solid var(--accent);border-radius:999px;padding:2px 8px;margin-right:4px;white-space:nowrap;cursor:pointer;">マスター更新</button>' +
    '<div class="toggle"><button id="bList">一覧</button><button id="bMap" class="on">地図</button></div></div>' +
    '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">' +
    '  <input id="q" type="search" placeholder="マンション名・住所で検索" autocomplete="off" style="flex:2;min-width:0;margin:0;">' +
    '  <a id="btnPortal" href="https://sites.google.com/view/jwnoborito-portal/" target="_top" style="flex:1;max-width:130px;height:36px;font-size:11px;color:var(--accent);text-decoration:none;border:1.5px solid var(--accent);background:var(--card);padding:0 4px;border-radius:8px;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;box-sizing:border-box;">区域サイト →</a>' +
    '</div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px;gap:6px;position:relative;">' +
    '  <div id="pinDropdownWrap" style="display:flex;align-items:center;gap:8px;min-width:0;position:relative;">' +
    '    <button id="btnPinDropdown" type="button" class="pin-dropdown-btn">📍 ピン表示: すべて ▼</button>' +
    '    <div id="count" style="margin:0;font-size:12px;font-weight:700;color:var(--sub);white-space:nowrap;"></div>' +
    '    <div id="pinDropdownMenu" class="pin-dropdown-menu" style="display:none;">' +
    '      <div class="pdm-head">' +
    '        <button id="pdmAll" type="button" class="pdm-btn-sm">すべて表示</button>' +
    '        <button id="pdmNone" type="button" class="pdm-btn-sm pdm-danger">ピン非表示</button>' +
    '        <button id="pdmClose" type="button" class="pdm-btn-sm pdm-primary">完了</button>' +
    '      </div>' +
    '      <div id="pdmList" class="pdm-list"></div>' +
    '    </div>' +
    '  </div>' +
    '  <span id="user-email" style="font-size:11px;color:var(--sub);padding-right:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>' +
    '</div></header>' +
    '<main id="list"></main>' +
    '<div id="mapwrap"><div id="map"></div><button id="locate">現在地</button>' +
    '  <div id="overlayBar" style="display:none;">' +
    '    <div class="obar-row">' +
    '      <span>透過率:</span>' +
    '      <input id="overlayOpacity" type="range" min="0" max="100" value="50">' +
    '      <span id="opacityTxt">50%</span>' +
    '      <button id="btnAdjustMode">位置調整 ⚙</button>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<div id="adjustModal" style="display:none;">' +
    '  <div class="adj-row1">' +
    '    <select id="adjTarget" style="flex:1;min-width:105px;font-size:13px;font-weight:700;padding:4px 6px;height:34px;border:1.5px solid var(--accent);border-radius:8px;background:var(--card);"></select>' +
    '    <div style="display:flex;align-items:center;gap:4px;background:var(--bg);padding:2px 6px;border-radius:8px;border:1px solid var(--line);height:34px;">' +
    '      <span style="font-size:11px;font-weight:700;color:var(--sub);white-space:nowrap;">透過</span>' +
    '      <input id="modalOverlayOpacity" type="range" min="0" max="100" value="50" style="width:55px;height:18px;accent-color:var(--accent);cursor:pointer;">' +
    '      <span id="modalOpacityTxt" style="font-size:11px;font-weight:700;min-width:28px;text-align:right;">50%</span>' +
    '    </div>' +
    '    <button id="btnAdjClose" class="adj-large-btn" style="background:var(--sub);color:#fff;padding:0 10px;height:34px;font-size:13px;white-space:nowrap;">完了</button>' +
    '  </div>' +
    '  <div class="adj-row2">' +
    '    <div class="adj-dpad">' +
    '      <div style="grid-column:2;grid-row:1;"><button class="adj-large-btn adj-arrow" id="adjUp" title="北へ移動">↑</button></div>' +
    '      <div style="grid-column:1;grid-row:2;"><button class="adj-large-btn adj-arrow" id="adjLeft" title="西へ移動">←</button></div>' +
    '      <div style="grid-column:2;grid-row:2;"><button class="adj-large-btn adj-arrow" id="adjDown" title="南へ移動">↓</button></div>' +
    '      <div style="grid-column:3;grid-row:2;"><button class="adj-large-btn adj-arrow" id="adjRight" title="東へ移動">→</button></div>' +
    '    </div>' +
    '    <div class="adj-actions">' +
    '      <button class="adj-large-btn" id="adjSave" style="background:var(--accent);color:#fff;">💾 保存</button>' +
    '      <button class="adj-large-btn" id="adjCopy" style="background:var(--card);color:var(--accent);border-color:var(--accent);">📋 座標コピー</button>' +
    '      <button class="adj-large-btn" id="adjReset" style="background:var(--card);color:#d93025;border-color:#d93025;font-size:11.5px;">初期位置</button>' +
    '      <button class="adj-large-btn" id="btnToggleSize" style="background:var(--bg);color:var(--sub);font-size:11.5px;">サイズ比率 ▾</button>' +
    '    </div>' +
    '  </div>' +
    '  <div id="adjSizePanel" class="adj-size-panel">' +
    '    <div style="grid-column:1/-1;font-size:11px;color:var(--sub);display:flex;justify-content:space-between;align-items:center;background:var(--bg);padding:3px 6px;border-radius:4px;border:1px solid var(--line);">' +
    '      <span id="adjStatusShift">移動: 北 0.0m / 東 0.0m</span>' +
    '      <span id="adjStatusScale">拡大: 100.0% (幅100% 高100%)</span>' +
    '    </div>' +
    '    <button class="adj-btn-sm" id="adjZoomIn" title="全体拡大">全体 ＋</button>' +
    '    <button class="adj-btn-sm" id="adjZoomOut" title="全体縮小">全体 −</button>' +
    '    <button class="adj-btn-sm" id="adjWiden" title="横幅拡大">幅 ＋</button>' +
    '    <button class="adj-btn-sm" id="adjNarrow" title="横幅縮小">幅 −</button>' +
    '    <button class="adj-btn-sm" id="adjTaller" title="縦幅拡大">高 ＋</button>' +
    '    <button class="adj-btn-sm" id="adjShorter" title="縦幅縮小">高 −</button>' +
    '  </div>' +
    '</div>' +
    '<div id="rec"><div id="recinner"><div id="rechead"><div style="flex:1;min-width:0;"><h2 id="rectitle" style="font-size:18px;font-weight:800;color:var(--text);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">訪問記録</h2><div id="rec-datetime" style="font-size:18px;color:var(--accent);margin-top:4px;font-weight:800;letter-spacing:-0.5px;"></div></div><button id="recclose">閉じる</button></div><div id="recbody"></div><div id="rec-dir" style="padding:10px 12px;display:none;background:var(--card);border-top:1px solid var(--line);"></div></div></div>' +
    '<div id="edit"><div id="editbox">' +
    '<div class="edithead"><p id="edittitle">記録</p><button id="editclose" aria-label="閉じる">×</button></div>' +
    '<div class="resrow" id="resrow"></div>' +
    '<div class="daterow"><label>日付</label><input id="editdate" type="text" placeholder="例 6/14 (土)"><div class="todaywrap"><button id="today" type="button">日付選択</button><input id="editdatepick" type="date" aria-label="日付を選択"></div></div>' +
    '<div class="btnrow"><button id="save">保存</button></div>' +
    '</div></div>' +
    '<script>' +
    'function setCookie(n,v,d){const dt=new Date();dt.setTime(dt.getTime()+(d*24*60*60*1000));const ex="expires="+dt.toUTCString();document.cookie=n+"="+encodeURIComponent(v)+";"+ex+";path=/;SameSite=Lax";}' +
    'function getCookie(n){const nm=n+"=";const dec=decodeURIComponent(document.cookie);const ca=dec.split(";");for(let i=0;i<ca.length;i++){let c=ca[i];while(c.charAt(0)==" ")c=c.substring(1);if(c.indexOf(nm)==0)return c.substring(nm.length,c.length);}return "";}' +
    'let DATA=[];' +
    'const COLORS=' + colorsJson + ';' +
    'const RESULTS=' + resultsJson + ';' +
    'const APP_ICON="' + WEBAPP.ICON_URL + '";' +
    'const WEBAPP_URL="' + webappUrl + '";' +
    'const CURRENT_VERSION="' + WEBAPP.VERSION + '";' +
    'const DEFC="' + WEBAPP.DEFAULT_COLOR + '";' +
    'let USER_EMAIL="";' +
    'const STANDALONE=(navigator.standalone===true)||window.matchMedia("(display-mode: standalone)").matches;' +
    'let curArea="";let curQ="";let mode="map";let map=null;let layer=null;let hidePins=false;' +
    'let watchId=null;let meMarker=null;let meCircle=null;let lastPos=null;let firstFix=true;' +
    'let savedView=null;' +
    'let curRec=null;' +
    'let curEdit=null;' +
    'let recTimer=null;' +
    'function pad2(n){return String(n).padStart(2,"0");}' +
    'function localTodayLabel(){const d=new Date();const w=["日","月","火","水","木","金","土"][d.getDay()];return (d.getMonth()+1)+"/"+d.getDate()+" ("+w+")";}' +
    'function localTodayIso(){const d=new Date();return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate());}' +
    'function labelFromIsoDate(s){const m=String(s||"").match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);if(!m)return "";const y=Number(m[1]),mo=Number(m[2]),da=Number(m[3]);const w=["日","月","火","水","木","金","土"][new Date(y,mo-1,da).getDay()];return mo+"/"+da+" ("+w+")";}' +
    'function isoFromDisplayDate(s){const t=String(s||"").trim();if(!t)return "";if(/^\\d{4}-\\d{2}-\\d{2}$/.test(t))return t;const m=t.match(/^(\\d{1,2})\\/(\\d{1,2})/);if(!m)return "";const y=(new Date()).getFullYear(),mo=Number(m[1]),da=Number(m[2]),dt=new Date(y,mo-1,da);if(dt.getFullYear()!==y||dt.getMonth()+1!==mo||dt.getDate()!==da)return "";return y+"-"+pad2(mo)+"-"+pad2(da);}' +
    'let todayStr=localTodayLabel();' +
    'google.script.run.withSuccessHandler(s=>{if(s)todayStr=s;}).getTodayLabel();' +
    'let selectedAreas=new Set();let allAreaList=[];' +
    'function saveState(){try{sessionStorage.setItem("st",JSON.stringify({sa:Array.from(selectedAreas),q:curQ,m:mode,v:savedView,hp:hidePins}));}catch(e){}}' +
    'let initMode="map";' +
    'try{const st=JSON.parse(sessionStorage.getItem("st")||"{}");curQ=st.q||"";if(st.sa&&Array.isArray(st.sa))selectedAreas=new Set(st.sa);if(st.v)savedView=st.v;if(st.hp!==undefined)hidePins=!!st.hp;}catch(e){}' +
    'const btnPinDropdown=document.getElementById("btnPinDropdown");' +
    'const pinDropdownMenu=document.getElementById("pinDropdownMenu");' +
    'const pdmList=document.getElementById("pdmList");' +
    'const pdmAll=document.getElementById("pdmAll");' +
    'const pdmNone=document.getElementById("pdmNone");' +
    'const pdmClose=document.getElementById("pdmClose");' +
    'function updatePinDropdownUI(){' +
    '  if(!btnPinDropdown)return;' +
    '  const total=allAreaList.length;' +
    '  const selCount=selectedAreas.size;' +
    '  if(hidePins){' +
    '    btnPinDropdown.textContent="🚫 ピン非表示 ▼";' +
    '    btnPinDropdown.classList.add("pins-hidden");' +
    '  }else if(selCount===0||selCount===total){' +
    '    btnPinDropdown.textContent="📍 ピン表示: すべて ▼";' +
    '    btnPinDropdown.classList.remove("pins-hidden");' +
    '  }else{' +
    '    btnPinDropdown.textContent="📍 ピン表示: "+selCount+"エリア ▼";' +
    '    btnPinDropdown.classList.remove("pins-hidden");' +
    '  }' +
    '}' +
    'function refreshCheckboxes(){' +
    '  if(!pdmList)return;' +
    '  const chks=pdmList.querySelectorAll("input[type=checkbox]");' +
    '  chks.forEach(chk=>{chk.checked=!hidePins&&selectedAreas.has(chk.value);});' +
    '  updatePinDropdownUI();' +
    '}' +
    'function buildPinDropdown(){' +
    '  if(!pdmList)return;' +
    '  allAreaList=[...new Set(DATA.map(r=>r.area))].filter(Boolean);' +
    '  if(selectedAreas.size===0&&!hidePins){allAreaList.forEach(a=>selectedAreas.add(a));}' +
    '  pdmList.innerHTML="";' +
    '  allAreaList.forEach(a=>{' +
    '    const cnt=DATA.filter(r=>r.area===a).length;' +
    '    const item=document.createElement("label");item.className="pdm-item";' +
    '    const chk=document.createElement("input");chk.type="checkbox";chk.value=a;chk.checked=!hidePins&&selectedAreas.has(a);' +
    '    chk.onchange=()=>{' +
    '      if(chk.checked){selectedAreas.add(a);hidePins=false;}' +
    '      else{selectedAreas.delete(a);if(selectedAreas.size===0)hidePins=true;}' +
    '      updatePinDropdownUI();render();saveState();' +
    '    };' +
    '    const txt=document.createElement("span");txt.textContent=a.replace(/エリア$/,"")+" ("+cnt+"件)";' +
    '    item.appendChild(chk);item.appendChild(txt);pdmList.appendChild(item);' +
    '  });' +
    '  updatePinDropdownUI();' +
    '}' +
    'if(btnPinDropdown&&pinDropdownMenu){' +
    '  btnPinDropdown.onclick=e=>{' +
    '    e.stopPropagation();' +
    '    const isShown=pinDropdownMenu.style.display==="flex";' +
    '    pinDropdownMenu.style.display=isShown?"none":"flex";' +
    '    if(!isShown)refreshCheckboxes();' +
    '  };' +
    '}' +
    'if(pdmAll){' +
    '  pdmAll.onclick=()=>{' +
    '    hidePins=false;allAreaList.forEach(a=>selectedAreas.add(a));refreshCheckboxes();render();saveState();' +
    '  };' +
    '}' +
    'if(pdmNone){' +
    '  pdmNone.onclick=()=>{' +
    '    hidePins=true;selectedAreas.clear();refreshCheckboxes();render();saveState();' +
    '  };' +
    '}' +
    'if(pdmClose){' +
    '  pdmClose.onclick=()=>{pinDropdownMenu.style.display="none";};' +
    '}' +
    'document.addEventListener("click",e=>{' +
    '  const wrap=document.getElementById("pinDropdownWrap");' +
    '  if(wrap&&!wrap.contains(e.target)&&pinDropdownMenu){pinDropdownMenu.style.display="none";}' +
    '});' +
    'function initApp() {' +
    '  buildPinDropdown();' +
    '  document.getElementById("q").value=curQ;' +
    '  setMode(mode||initMode);' +
    '}' +
    'document.getElementById("q").addEventListener("input",e=>{' +
    '  curQ=e.target.value.trim();' +
    '  const btn=document.getElementById("btnUpdate");' +
    '  if(btn){btn.style.display=(curQ==="管理者")?"":"none";}' +
    '  render();' +
    '});' +
    'document.getElementById("bList").onclick=()=>setMode("list");' +
    'document.getElementById("bMap").onclick=()=>setMode("map");' +
    'document.getElementById("locate").onclick=locate;' +
    'document.getElementById("recclose").onclick=closeRec;' +
    'document.getElementById("editclose").onclick=closeEdit;' +
    'document.getElementById("edit").onclick=e=>{if(e.target===e.currentTarget)closeEdit();};' +
    'const editDateInput=document.getElementById("editdate");' +
    'const editDatePicker=document.getElementById("editdatepick");' +
    'function syncDatePickerFromText(){editDatePicker.value=isoFromDisplayDate(editDateInput.value)||localTodayIso();}' +
    'editDateInput.addEventListener("input",syncDatePickerFromText);' +
    'editDatePicker.addEventListener("input",e=>{editDateInput.value=labelFromIsoDate(e.target.value)||"";});' +
    'editDatePicker.addEventListener("change",e=>{editDateInput.value=labelFromIsoDate(e.target.value)||"";});' +
    'editDatePicker.addEventListener("click",syncDatePickerFromText);' +
    'document.getElementById("save").onclick=doSave;' +
    'function setMode(m){mode=m;' +
    ' document.getElementById("bList").classList.toggle("on",m==="list");' +
    ' document.getElementById("bMap").classList.toggle("on",m==="map");' +
    ' document.getElementById("list").style.display=(m==="list")?"":"none";' +
    ' document.getElementById("mapwrap").style.display=(m==="map")?"flex":"none";' +
    ' if(m==="map"){initMap();setTimeout(()=>map.invalidateSize(),50);}render();}' +
    'function locate(){if(!navigator.geolocation){alert("この端末では位置情報を利用できません。");return;}' +
    ' if(watchId!==null){if(lastPos)map.setView(lastPos,Math.max(map.getZoom(),16));return;}' +
    ' firstFix=true;document.getElementById("locate").classList.add("on");' +
    ' watchId=navigator.geolocation.watchPosition(pos=>{lastPos=[pos.coords.latitude,pos.coords.longitude];const acc=pos.coords.accuracy||30;' +
    '  if(!meMarker){meCircle=L.circle(lastPos,{radius:acc,color:"#34a853",weight:1,fillColor:"#34a853",fillOpacity:0.12,interactive:false}).addTo(map);' +
    '   const meIcon=L.divIcon({className:"",html:"<div class=me-wrap><div class=me-pulse></div><div class=me-emoji>\\ud83d\\udccd</div></div>",iconSize:[36,40],iconAnchor:[18,38]});' +
    '   meMarker=L.marker(lastPos,{icon:meIcon,zIndexOffset:1000}).addTo(map);' +
    '  }else{meMarker.setLatLng(lastPos);meCircle.setLatLng(lastPos);meCircle.setRadius(acc);}' +
    '  if(firstFix){firstFix=false;map.setView(lastPos,16);}' +
    ' },err=>{stopLocate();if(err.code===1)alert("位置情報の利用が許可されていません。");else alert("現在地を取得できませんでした（"+err.message+"）");' +
    ' },{enableHighAccuracy:true,maximumAge:5000,timeout:15000});}' +
    'function stopLocate(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;}document.getElementById("locate").classList.remove("on");}' +
    'function hits_(){const q=curQ.toLowerCase();return DATA.filter(r=>((selectedAreas.size===0||selectedAreas.size===allAreaList.length||selectedAreas.has(r.area)))&&(!q||r.name.toLowerCase().includes(q)||r.addr.toLowerCase().includes(q)));}' +
    'function render(){' +
    ' const hits=hits_();' +
    ' document.getElementById("count").textContent=hits.length+"件";' +
    ' if(mode==="list")renderList(hits);else renderMap(hits);saveState();}' +
    'function renderList(hits){const list=document.getElementById("list");list.innerHTML="";' +
    ' if(hits.length===0){list.innerHTML="<div class=empty>該当なし</div>";return;}let lastArea=null;' +
    ' hits.forEach(r=>{if(r.area!==lastArea){lastArea=r.area;const h=document.createElement("div");h.className="ghead";h.textContent=r.area;list.appendChild(h);}' +
    '  const c=document.createElement("div");c.className="card";' +
    '  const a=document.createElement("a");a.textContent=r.name;a.onclick=()=>openRec(r);' +
    '  const info=document.createElement("div");info.className="info";' +
    '  const nm=document.createElement("div");nm.className="name";nm.appendChild(a);' +
    '  const meta=document.createElement("div");meta.className="meta";' +
    '  meta.innerHTML=(r.type?"<span class=badge>"+esc(r.type)+"</span>":"")+"<span>"+esc(r.addr)+"</span>";' +
    '  info.appendChild(nm);info.appendChild(meta);' +
    '  const mapa=document.createElement("a");mapa.className="maplink";mapa.textContent="Map";' +
    '  mapa.href="https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(r.name+" "+r.addr);mapa.target="_blank";mapa.rel="noopener";' +
    '  c.appendChild(info);c.appendChild(mapa);list.appendChild(c);});}' +
    'function initMap(){if(map)return;map=L.map("map");' +
    ' const ga="<a href=\\"https://maps.gsi.go.jp/development/ichiran.html\\" target=\\"_blank\\" rel=\\"noopener\\">国土地理院</a>";' +
    ' const oa="&copy; <a href=\\"https://www.openstreetmap.org/copyright\\" target=\\"_blank\\" rel=\\"noopener\\">OpenStreetMap</a>";' +
    ' const baseMaps={' +
    '  "通常 (OSM)":L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:oa}),' +
    '  "地理院 標準":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png",{maxNativeZoom:18,maxZoom:19,attribution:ga}),' +
    '  "地理院 淡色":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",{maxNativeZoom:18,maxZoom:19,attribution:ga}),' +
    '  "写真 (最新)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",{maxNativeZoom:18,maxZoom:19,attribution:ga}),' +
    '  "写真 (2007年〜)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg",{minZoom:14,maxNativeZoom:18,maxZoom:19,attribution:ga}),' +
    '  "写真 (2004年〜)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/airphoto/{z}/{x}/{y}.png",{minZoom:9,maxNativeZoom:18,maxZoom:19,attribution:ga}),' +
    '  "写真 (1987-90)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/gazo4/{z}/{x}/{y}.jpg",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1984-86)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/gazo3/{z}/{x}/{y}.jpg",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1979-83)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/gazo2/{z}/{x}/{y}.jpg",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1974-78)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/gazo1/{z}/{x}/{y}.jpg",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1961-69)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/ort_old10/{z}/{x}/{y}.png",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1945-50 米軍)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/ort_USA10/{z}/{x}/{y}.png",{minZoom:10,maxNativeZoom:17,maxZoom:19,attribution:ga}),' +
    '  "写真 (1936頃 陸軍)":L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/ort_riku10/{z}/{x}/{y}.png",{minZoom:11,maxNativeZoom:17,maxZoom:19,attribution:ga})' +
    ' };' +
    ' const MAP_OVERLAY_BASE="https://raw.githubusercontent.com/h183skt/kuiki/feature/area-map-overlay/%E7%99%BB%E6%88%B8%E5%8C%BA%E5%9F%9F%E5%9C%B0%E5%9B%B3/";' +
    ' const OVERLAY_DEFS=[' +
    '  {id:"161-175",label:"登戸 161-175 (区画整理)",file:"登戸区域_161-175",defBounds:[[35.616138,139.558857],[35.622527,139.569327]]},' +
    '  {id:"001-048",label:"登戸 001-048 (宿河原)",file:"登戸区域_001-048",defBounds:[[35.609009,139.575268],[35.620591,139.594932]]},' +
    '  {id:"049-059",label:"登戸 049-059 (登戸・多摩川)",file:"登戸区域_049-059",defBounds:[[35.615926,139.568553],[35.622674,139.579847]]},' +
    '  {id:"060-099",label:"登戸 060-099 (登戸・遊園)",file:"登戸区域_060-099",defBounds:[[35.611554,139.561851],[35.621646,139.579349]]},' +
    '  {id:"100-123",label:"登戸 100-123 (生田緑地)",file:"登戸区域_100-123",defBounds:[[35.601408,139.559431],[35.617492,139.572869]]},' +
    '  {id:"124-144",label:"登戸 124-144 (登戸公園)",file:"登戸区域_124-144",defBounds:[[35.620666,139.558500],[35.628134,139.571600]]},' +
    '  {id:"145-160",label:"登戸 145-160 (カリタス)",file:"登戸区域_145-160",defBounds:[[35.625481,139.551618],[35.633919,139.566382]]},' +
    '  {id:"176-205",label:"登戸 176-205 (台和・宿河原)",file:"登戸区域_176-205",defBounds:[[35.617465,139.547739],[35.628698,139.567223]]}' +
    ' ];' +
    ' let customBounds={};try{const bs=localStorage.getItem("kuiki_overlay_bounds");if(bs)customBounds=JSON.parse(bs);}catch(e){}' +
    ' let curOpacity=0.50;' +
    ' try{' +
    '  const opStr=localStorage.getItem("kuiki_overlay_opacity");' +
    '  if(opStr!==null&&opStr!=="")curOpacity=parseFloat(opStr);' +
    '  else if(savedView&&savedView.overlayOpacity!==undefined)curOpacity=savedView.overlayOpacity;' +
    ' }catch(e){}' +
    ' const overlayLayers={};const overlayMapLayers={};const activeOverlays=new Set((savedView&&savedView.overlays)?savedView.overlays:[]);' +
    ' OVERLAY_DEFS.forEach(d=>{' +
    '  const b=customBounds[d.id]||d.defBounds;' +
    '  const url=MAP_OVERLAY_BASE+encodeURIComponent(d.file)+".webp";' +
    '  const lyr=L.imageOverlay(url,b,{opacity:curOpacity,interactive:false,zIndex:200});' +
    '  overlayLayers[d.id]={layer:lyr,def:d,bounds:b};' +
    '  overlayMapLayers[d.label]=lyr;' +
    ' });' +
    ' let curBase=(savedView&&savedView.b&&baseMaps[savedView.b])?savedView.b:"通常 (OSM)";' +
    ' baseMaps[curBase].addTo(map);' +
    ' const overlayControl=L.control.layers(null,overlayMapLayers,{position:"topright",collapsed:true}).addTo(map);' +
    ' const baseControl=L.control.layers(baseMaps,null,{position:"topright",collapsed:true}).addTo(map);' +
    ' const addLyrHead=(ctrl,el,label,color)=>{' +
    '  const inject=()=>{' +
    '   const targetEl=el.querySelector(".leaflet-control-layers-list, form")||el;' +
    '   if(!targetEl||targetEl.querySelector(".lyr-head"))return;' +
    '   const head=document.createElement("div");head.className="lyr-head";' +
    '   const t=document.createElement("span");t.className="lyr-title";t.style.color=color;t.textContent=label;' +
    '   const done=document.createElement("button");done.type="button";done.className="pdm-btn-sm pdm-primary";done.textContent="完了";' +
    '   done.onclick=ev=>{ev.preventDefault();ev.stopPropagation();if(typeof ctrl.collapse==="function")ctrl.collapse();else el.classList.remove("leaflet-control-layers-expanded");};' +
    '   head.appendChild(t);head.appendChild(done);targetEl.insertBefore(head,targetEl.firstChild);' +
    '  };' +
    '  inject();' +
    '  el.addEventListener("mouseenter",inject);' +
    '  el.addEventListener("click",inject);' +
    ' };' +
    ' const overlayCtrlEl=overlayControl.getContainer();' +
    ' if(overlayCtrlEl){' +
    '  overlayCtrlEl.classList.add("leaflet-control-overlay-map");' +
    '  const tBtn=overlayCtrlEl.querySelector(".leaflet-control-layers-toggle");' +
    '  if(tBtn){tBtn.title="登戸区域地図レイヤー";tBtn.innerHTML=\'<span class="ctrl-btn-badge">区域</span>\';}' +
    '  addLyrHead(overlayControl,overlayCtrlEl,"🗺️ 登戸区域地図","var(--accent)");' +
    ' }' +
    ' const baseCtrlEl=baseControl.getContainer();' +
    ' if(baseCtrlEl){' +
    '  baseCtrlEl.classList.add("leaflet-control-base-map");' +
    '  const tBtn=baseCtrlEl.querySelector(".leaflet-control-layers-toggle");' +
    '  if(tBtn){tBtn.title="衛星写真・背景地図レイヤー";tBtn.innerHTML=\'<span class="ctrl-btn-badge">写真</span>\';}' +
    '  addLyrHead(baseControl,baseCtrlEl,"🛰️ 背景地図・衛星写真","#1e8e3e");' +
    ' }' +
    ' OVERLAY_DEFS.forEach(d=>{if(activeOverlays.has(d.id))overlayLayers[d.id].layer.addTo(map);});' +
    ' const obar=document.getElementById("overlayBar");' +
    ' const opSlider=document.getElementById("overlayOpacity");' +
    ' const opTxt=document.getElementById("opacityTxt");' +
    ' const btnAdj=document.getElementById("btnAdjustMode");' +
    ' const adjModal=document.getElementById("adjustModal");' +
    ' const btnAdjClose=document.getElementById("btnAdjClose");' +
    ' const selTarget=document.getElementById("adjTarget");' +
    ' let adjustMode=false;let adjustMarkers=[];' +
    ' function updateOverlayBar(){' +
    '  if(!obar)return;' +
    '  if(activeOverlays.size>0){' +
    '   obar.style.display="flex";' +
    '   if(selTarget){' +
    '    const prevVal=selTarget.value;' +
    '    selTarget.innerHTML="";' +
    '    OVERLAY_DEFS.forEach(d=>{' +
    '     if(activeOverlays.has(d.id)){' +
    '      const opt=document.createElement("option");opt.value=d.id;opt.textContent=d.label.replace("登戸 ","");' +
    '      selTarget.appendChild(opt);' +
    '     }' +
    '    });' +
    '    if(prevVal&&activeOverlays.has(prevVal))selTarget.value=prevVal;' +
    '   }' +
    '  }else{' +
    '   obar.style.display="none";' +
    '   if(adjustMode)toggleAdjustMode(false);' +
    '  }' +
    ' }' +
    ' const mOpSlider=document.getElementById("modalOverlayOpacity");' +
    ' const mOpTxt=document.getElementById("modalOpacityTxt");' +
    ' function syncOpacity(val){' +
    '  curOpacity=val/100;' +
    '  const str=val+"%";' +
    '  if(opSlider)opSlider.value=val;' +
    '  if(opTxt)opTxt.textContent=str;' +
    '  if(mOpSlider)mOpSlider.value=val;' +
    '  if(mOpTxt)mOpTxt.textContent=str;' +
    '  Object.keys(overlayLayers).forEach(k=>overlayLayers[k].layer.setOpacity(curOpacity));' +
    '  if(!savedView)savedView={};savedView.overlayOpacity=curOpacity;saveState();' +
    '  try{localStorage.setItem("kuiki_overlay_opacity",String(curOpacity));}catch(e){}' +
    ' }' +
    ' syncOpacity(Math.round(curOpacity*100));' +
    ' if(opSlider)opSlider.oninput=()=>syncOpacity(parseInt(opSlider.value,10));' +
    ' if(mOpSlider)mOpSlider.oninput=()=>syncOpacity(parseInt(mOpSlider.value,10));' +
    ' function clearAdjustMarkers(){adjustMarkers.forEach(m=>map.removeLayer(m));adjustMarkers=[];}' +
    ' function refreshAdjustMarkers(){' +
    '  clearAdjustMarkers();' +
    '  if(!adjustMode||!selTarget||!selTarget.value)return;' +
    '  const id=selTarget.value;const item=overlayLayers[id];if(!item)return;' +
    '  const b=item.bounds;' +
    '  const pts=[' +
    '   {pos:[b[0][0],b[0][1]],idx:"sw"},' +
    '   {pos:[b[1][0],b[1][1]],idx:"ne"},' +
    '   {pos:[b[1][0],b[0][1]],idx:"nw"},' +
    '   {pos:[b[0][0],b[1][1]],idx:"se"}' +
    '  ];' +
    '  pts.forEach(p=>{' +
    '   const m=L.marker(p.pos,{draggable:true,icon:L.divIcon({className:"corner-pin",iconSize:[24,24],iconAnchor:[12,12]})}).addTo(map);' +
    '   m.on("drag",()=>{' +
    '    const lat=m.getLatLng().lat;const lng=m.getLatLng().lng;' +
    '    if(p.idx==="sw"){b[0][0]=lat;b[0][1]=lng;}' +
    '    else if(p.idx==="ne"){b[1][0]=lat;b[1][1]=lng;}' +
    '    else if(p.idx==="nw"){b[1][0]=lat;b[0][1]=lng;}' +
    '    else if(p.idx==="se"){b[0][0]=lat;b[1][1]=lng;}' +
    '    item.layer.setBounds(b);' +
    '    adjustMarkers.forEach(om=>{' +
    '     if(om===m)return;' +
    '     if(om._posIdx==="sw")om.setLatLng([b[0][0],b[0][1]]);' +
    '     else if(om._posIdx==="ne")om.setLatLng([b[1][0],b[1][1]]);' +
    '     else if(om._posIdx==="nw")om.setLatLng([b[1][0],b[0][1]]);' +
    '     else if(om._posIdx==="se")om.setLatLng([b[0][0],b[1][1]]);' +
    '    });' +
    '   });' +
    '   m._posIdx=p.idx;adjustMarkers.push(m);' +
    '  });' +
    ' }' +
    ' function toggleAdjustMode(flag){' +
    '  adjustMode=(flag!==undefined)?flag:!adjustMode;' +
    '  if(btnAdj)btnAdj.classList.toggle("on",adjustMode);' +
    '  if(adjModal)adjModal.style.display=adjustMode?"flex":"none";' +
    '  if(adjustMode){refreshAdjustMarkers();updateAdjStatus();}else clearAdjustMarkers();' +
    ' }' +
    ' if(btnAdj)btnAdj.onclick=()=>toggleAdjustMode();' +
    ' if(btnAdjClose)btnAdjClose.onclick=()=>toggleAdjustMode(false);' +
    ' if(selTarget)selTarget.onchange=()=>{refreshAdjustMarkers();updateAdjStatus();};' +
    ' function getOverlayMetrics(id){' +
    '  const item=overlayLayers[id];if(!item)return null;' +
    '  const b=item.bounds;const d=item.def.defBounds;' +
    '  const curW=b[1][1]-b[0][1];const curH=b[1][0]-b[0][0];' +
    '  const defW=d[1][1]-d[0][1];const defH=d[1][0]-d[0][0];' +
    '  const curCLat=(b[0][0]+b[1][0])/2;const curCLng=(b[0][1]+b[1][1])/2;' +
    '  const defCLat=(d[0][0]+d[1][0])/2;const defCLng=(d[0][1]+d[1][1])/2;' +
    '  const dLatM=(curCLat-defCLat)*111000;' +
    '  const dLngM=(curCLng-defCLng)*(111000*Math.cos(curCLat*Math.PI/180));' +
    '  const scaleW=curW/defW;const scaleH=curH/defH;' +
    '  const scaleTotal=Math.sqrt(scaleW*scaleH);' +
    '  return {' +
    '   bounds:[[Number(b[0][0].toFixed(6)),Number(b[0][1].toFixed(6))],[Number(b[1][0].toFixed(6)),Number(b[1][1].toFixed(6))]],' +
    '   center:[Number(curCLat.toFixed(6)),Number(curCLng.toFixed(6))],' +
    '   size:{widthDeg:Number(curW.toFixed(6)),heightDeg:Number(curH.toFixed(6)),widthMeters:Math.round(curW*(111000*Math.cos(curCLat*Math.PI/180))),heightMeters:Math.round(curH*111000)},' +
    '   scaleFromDefault:{totalPercent:(scaleTotal*100).toFixed(1)+"%",widthPercent:(scaleW*100).toFixed(1)+"%",heightPercent:(scaleH*100).toFixed(1)+"%",scaleWidth:Number(scaleW.toFixed(4)),scaleHeight:Number(scaleH.toFixed(4))},' +
    '   offsetFromDefaultMeters:{dNorthM:Number(dLatM.toFixed(1)),dEastM:Number(dLngM.toFixed(1))}' +
    '  };' +
    ' }' +
    ' function updateAdjStatus(){' +
    '  if(!selTarget||!selTarget.value)return;' +
    '  const m=getOverlayMetrics(selTarget.value);if(!m)return;' +
    '  const elShift=document.getElementById("adjStatusShift");' +
    '  const elScale=document.getElementById("adjStatusScale");' +
    '  if(elShift)elShift.textContent="移動: " + (m.offsetFromDefaultMeters.dNorthM>=0?"北+":"南")+Math.abs(m.offsetFromDefaultMeters.dNorthM)+"m / " + (m.offsetFromDefaultMeters.dEastM>=0?"東+":"西")+Math.abs(m.offsetFromDefaultMeters.dEastM)+"m";' +
    '  if(elScale)elScale.textContent="拡大: " + m.scaleFromDefault.totalPercent + " (幅" + m.scaleFromDefault.widthPercent + " 高" + m.scaleFromDefault.heightPercent + ")";' +
    ' }' +
    ' function nudge(dLat,dLng,scaleLat,scaleLng){' +
    '  if(!selTarget||!selTarget.value)return;' +
    '  const id=selTarget.value;const item=overlayLayers[id];if(!item)return;' +
    '  const b=item.bounds;' +
    '  const cLat=(b[0][0]+b[1][0])/2;const cLng=(b[0][1]+b[1][1])/2;' +
    '  let h=(b[1][0]-b[0][0])*scaleLat;let w=(b[1][1]-b[0][1])*scaleLng;' +
    '  const nLat=cLat+dLat;const nLng=cLng+dLng;' +
    '  b[0][0]=nLat-h/2;b[1][0]=nLat+h/2;b[0][1]=nLng-w/2;b[1][1]=nLng+w/2;' +
    '  item.layer.setBounds(b);refreshAdjustMarkers();updateAdjStatus();' +
    ' }' +
    ' const step=0.00005;' +
    ' const bindAdj=(id,fn)=>{const el=document.getElementById(id);if(el)el.onclick=fn;};' +
    ' bindAdj("adjUp",()=>nudge(step,0,1,1));' +
    ' bindAdj("adjDown",()=>nudge(-step,0,1,1));' +
    ' bindAdj("adjLeft",()=>nudge(0,-step,1,1));' +
    ' bindAdj("adjRight",()=>nudge(0,step,1,1));' +
    ' bindAdj("adjZoomIn",()=>nudge(0,0,1.01,1.01));' +
    ' bindAdj("adjZoomOut",()=>nudge(0,0,0.99,0.99));' +
    ' bindAdj("adjWiden",()=>nudge(0,0,1,1.01));' +
    ' bindAdj("adjNarrow",()=>nudge(0,0,1,0.99));' +
    ' bindAdj("adjTaller",()=>nudge(0,0,1.01,1));' +
    ' bindAdj("adjShorter",()=>nudge(0,0,0.99,1));' +
    ' bindAdj("adjSave",()=>{' +
    '  if(!selTarget||!selTarget.value)return;' +
    '  const id=selTarget.value;const item=overlayLayers[id];if(!item)return;' +
    '  customBounds[id]=item.bounds;' +
    '  try{localStorage.setItem("kuiki_overlay_bounds",JSON.stringify(customBounds));alert("区域図「"+item.def.label+"」の位置を保存しました。");}catch(e){alert("保存に失敗しました: "+e);}' +
    ' });' +
    ' bindAdj("adjReset",()=>{' +
    '  if(!selTarget||!selTarget.value)return;' +
    '  const id=selTarget.value;const item=overlayLayers[id];if(!item)return;' +
    '  item.bounds=JSON.parse(JSON.stringify(item.def.defBounds));' +
    '  delete customBounds[id];' +
    '  try{localStorage.setItem("kuiki_overlay_bounds",JSON.stringify(customBounds));}catch(e){}' +
    '  item.layer.setBounds(item.bounds);refreshAdjustMarkers();updateAdjStatus();alert("初期位置に戻しました。");' +
    ' });' +
    ' bindAdj("adjCopy",()=>{' +
    '  const exportData={};' +
    '  OVERLAY_DEFS.forEach(d=>{exportData[d.id]=getOverlayMetrics(d.id);});' +
    '  const jsonStr=JSON.stringify(exportData,null,2);' +
    '  if(navigator.clipboard&&navigator.clipboard.writeText){' +
    '   navigator.clipboard.writeText(jsonStr).then(()=>{' +
    '    alert("確定座標・中心・拡大縮小率・移動量の全数値をコピーしました！\\nチャットに貼り付けてお知らせください。");' +
    '   }).catch(()=>{prompt("以下の設定データをコピーしてください:",jsonStr);});' +
    '  }else{prompt("以下の設定データをコピーしてください:",jsonStr);}' +
    ' });' +
    ' const btnToggleSize=document.getElementById("btnToggleSize");' +
    ' const adjSizePanel=document.getElementById("adjSizePanel");' +
    ' if(btnToggleSize&&adjSizePanel){' +
    '  btnToggleSize.onclick=()=>{' +
    '   const isShown=adjSizePanel.classList.toggle("show");' +
    '   btnToggleSize.textContent=isShown?"サイズ閉じる ▴":"サイズ比率 ▾";' +
    '  };' +
    ' }' +
    ' document.querySelectorAll(".adj-large-btn, .adj-btn-sm").forEach(btn=>{' +
    '  btn.onselectstart=e=>e.preventDefault();' +
    '  btn.onmousedown=e=>e.preventDefault();' +
    ' });' +
    ' map.on("overlayadd",e=>{' +
    '  const d=OVERLAY_DEFS.find(x=>x.label===e.name);' +
    '  if(d){activeOverlays.add(d.id);if(!savedView)savedView={};savedView.overlays=Array.from(activeOverlays);saveState();updateOverlayBar();if(adjustMode)refreshAdjustMarkers();}' +
    ' });' +
    ' map.on("overlayremove",e=>{' +
    '  const d=OVERLAY_DEFS.find(x=>x.label===e.name);' +
    '  if(d){activeOverlays.delete(d.id);if(!savedView)savedView={};savedView.overlays=Array.from(activeOverlays);saveState();updateOverlayBar();if(adjustMode)refreshAdjustMarkers();}' +
    ' });' +
    ' updateOverlayBar();' +
    ' map.on("baselayerchange",e=>{curBase=e.name;if(!savedView)savedView={};savedView.b=curBase;saveState();});' +
    ' layer=L.layerGroup().addTo(map);' +
    ' if(savedView&&savedView.c){map.setView(savedView.c,savedView.z);}else{map.setView([35.62,139.57],14);}' +
    ' map.on("moveend",()=>{if(!savedView)savedView={};savedView.c=[map.getCenter().lat,map.getCenter().lng];savedView.z=map.getZoom();savedView.b=curBase;saveState();});}' +
    'function renderMap(hits){if(!map)return;layer.clearLayers();if(hidePins)return;const pts=[];' +
    ' const groups={};' +
    ' hits.forEach(r=>{if(r.lat===null||r.lng===null)return;const key=r.lat+","+r.lng;if(!groups[key])groups[key]=[];groups[key].push(r);});' +
    ' Object.keys(groups).forEach(key=>{const items=groups[key];const first=items[0];pts.push([first.lat,first.lng]);' +
    '  const isMulti=items.length>1;let col=COLORS[first.type]||DEFC;' +
    '  if(isMulti){const types=new Set(items.map(x=>x.type));if(types.size>1){col=COLORS["混在"]||"#f9ab00";}}' +
    '  const isRefused=items.every(x=>!!x.state);' +
    '  const mk=isRefused' +
    '   ?L.marker([first.lat,first.lng],{icon:L.divIcon({className:"",html:"<div class=refuse-pin>×</div>",iconSize:[20,20],iconAnchor:[10,10]})})' +
    '   :L.circleMarker([first.lat,first.lng],{radius:9,color:"#fff",weight:2,fillColor:col,fillOpacity:0.95});' +
    '  const dirBase="https://www.google.com/maps/dir/?api=1&destination="+first.lat+","+first.lng+"&travelmode=";' +
    '  const dirBtns="<div class=dirrow>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"walking\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb6 徒歩</a>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"bicycling\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb2 自転車</a>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"driving\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\ude97 車</a></div>";' +
    '  let popHtml="<div class=pop>";const handlers=[];' +
    '  if(!isMulti){const r=first;const popId="rb_"+Math.random().toString(36).slice(2);const closeId="cb_"+Math.random().toString(36).slice(2);handlers.push({id:popId,closeId:closeId,r:r});' +
    '   const btnCls=r.state?"recbtn disabled":"recbtn";' +
    '   popHtml+=(r.type?"<span class=pbadge>"+esc(r.type)+"</span><br>":"")+' +
    '    "<div class=pname>"+esc(r.name)+"</div><div class=paddr>"+esc(r.addr)+"</div>"+dirBtns+' +
    '    "<div class=actionrow><div class=\\""+btnCls+"\\" id="+popId+">訪問記録を開く</div><div class=closebtn id="+closeId+">閉じる</div></div>";' +
    '  }else{' +
    '   popHtml+="<div class=paddr style=\\"font-weight:bold;margin-bottom:5px;\\">"+esc(first.addr)+"</div>"+dirBtns;' +
    '   items.forEach(r=>{const popId="rb_"+Math.random().toString(36).slice(2);const closeId="cb_"+Math.random().toString(36).slice(2);handlers.push({id:popId,closeId:closeId,r:r});' +
    '    const btnCls=r.state?"recbtn disabled":"recbtn";' +
    '    popHtml+="<div style=\\"margin-top:8px;border-top:1px solid var(--line);padding-top:8px;\\">"+' +
    '     (r.type?"<span class=pbadge style=\\"background:"+(COLORS[r.type]||DEFC)+";color:#fff;\\">"+esc(r.type)+"</span> ":"")+' +
    '     "<span class=pname style=\\"font-size:14px;\\">"+esc(r.name)+"</span>"+' +
    '     "<div class=actionrow><div class=\\""+btnCls+"\\" id="+popId+">訪問記録を開く</div><div class=closebtn id="+closeId+">閉じる</div></div></div>";});' +
    '  }' +
    '  popHtml+="</div>";' +
    '  mk.bindPopup(popHtml);' +
    '  mk.on("popupopen",()=>{handlers.forEach(h=>{' +
    '    const el=document.getElementById(h.id);if(el&&!h.r.state)el.onclick=()=>openRec(h.r);' +
    '    const cel=document.getElementById(h.closeId);if(cel)cel.onclick=()=>map.closePopup();' +
    '  });});' +
    '  mk.addTo(layer);});' +
    ' if(pts.length>0&&watchId===null&&!savedView)map.fitBounds(pts,{padding:[30,30],maxZoom:17});}' +
    'function openRec(r){try{history.pushState({m:"rec"},"");}catch(e){}' +
    ' curSheetIndex=0;const m=document.getElementById("rec");m.style.display="block";' +
    ' document.getElementById("rectitle").textContent=r.name;' +
    ' const dirEl=document.getElementById("rec-dir");if(dirEl)dirEl.style.display="none";' +
    ' if(recTimer)clearInterval(recTimer);' +
    ' const tick=()=>{const dtEl=document.getElementById("rec-datetime");if(dtEl){' +
    '  const d=new Date();const w=["日","月","火","水","木","金","土"][d.getDay()];' +
    '  dtEl.textContent=(d.getMonth()+1)+"/"+d.getDate()+" ("+w+") "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+":"+String(d.getSeconds()).padStart(2,"0");' +
    ' }};tick();recTimer=setInterval(tick,1000);' +
    ' const body=document.getElementById("recbody");body.innerHTML="<div class=\\"loading-wrap\\"><img src=\\""+APP_ICON+"\\" class=\\"loading-logo\\"><div class=\\"spinner\\"></div><p>訪問記録を読み込み中…</p></div>";' +
    ' if(!r.url){body.innerHTML="<p class=recnote>この建物にはシートのURLが設定されていません。</p>";return;}' +
    ' google.script.run.withSuccessHandler(res=>{curRec={r:r,data:res};renderRec();}).withFailureHandler(err=>{' +
    '  const friendly=friendlyErr(err,false);let html="<div style=\\"padding:12px;\\"><p class=recnote>"+esc(friendly)+"</p>";' +
    '  if(friendly.indexOf("権限がないため")!==-1&&USER_EMAIL){' +
    '    html+="<div style=\\"border:1px solid #f5c2c7;background:#f8d7da;color:#842029;border-radius:10px;padding:12px;margin-top:14px;font-size:14.5px;line-height:1.6;font-weight:normal;text-align:left;\\">" +' +
    '      "登録（共有設定）が必要なアカウント:<br>" +' +
    '      "<div style=\\"background:#fff;border:1px solid #f5c2c7;border-radius:6px;padding:8px;text-align:center;font-size:16px;font-weight:800;text-decoration:underline;color:#202124;word-break:break-all;margin-top:8px;\\">" + esc(USER_EMAIL) + "</div></div>";' +
    '  }' +
    '  html+="</div>";body.innerHTML=html;}).getVisitRecords(r.url);}' +
    'function closeRec(){closeEdit();document.getElementById("rec").style.display="none";curRec=null;if(recTimer){clearInterval(recTimer);recTimer=null;}const dirEl=document.getElementById("rec-dir");if(dirEl)dirEl.style.display="none";}' +
    'function currentPeriodIndex(){return Math.floor(new Date().getMonth()/3);}' +
    'function renderRec(){const body=document.getElementById("recbody");const res=curRec.data;' +
    ' if(!res||!res.ok){body.innerHTML="<p class=recnote>読み込みに失敗しました: "+esc(res&&res.error?res.error:"不明なエラー")+"</p>";return;}' +
    ' if(!res.rooms||res.rooms.length===0){body.innerHTML="<p class=recnote>部屋データが見つかりませんでした。</p>";return;}' +
    ' const periods=res.periods;const reps=["1回目","2回目","3回目"];const curPi=currentPeriodIndex();' +
    ' let h="<p class=recnote>セルをタップして記録を入力できます。</p>";' +
    ' h+="<table class=rectable><thead><tr><th class=rm>部屋</th>";' +
    ' periods.forEach((p,pi)=>{reps.forEach(rep=>{h+="<th"+(pi===curPi?" class=\\"curp\\"":"")+">"+esc(p)+"<br>"+rep+"</th>";});});' +
    ' h+="</tr></thead><tbody>";' +
    ' res.rooms.forEach((room,ri)=>{' +
    '  const startCi=curPi*3;let targetCi=-1;' +
    '  for(let offset=0;offset<3;offset++){' +
    '    const ciTemp=startCi+offset;' +
    '    const cellTemp=room.cells[ciTemp];' +
    '    if(cellTemp&&!cellTemp.result&&!cellTemp.date){' +
    '      targetCi=ciTemp;break;' +
    '    }' +
    '  }' +
    '  h+="<tr><td class=rm>"+esc(room.room)+"</td>";' +
    '  room.cells.forEach((cell,ci)=>{const f=(cell.result||cell.date)?" filled":"";' +
    '   const active=(ci===targetCi)?" active-cell":"";' +
    '   const pi=Math.floor(ci/3);const past=(pi<curPi)?" past-cell":"";' +
    '   h+="<td class=\\"cell"+f+active+past+"\\" data-ri="+ri+" data-ci="+ci+"><div class=res>"+esc(cell.result)+"</div><div class=date>"+esc(cell.date)+"</div></td>";});' +
    '  h+="</tr>";});' +
    ' h+="</tbody></table>";body.innerHTML=h;' +
    ' const curp=body.querySelector("th.curp");' +
    ' if(curp){const rm=body.querySelector("th.rm");const off=rm?rm.offsetWidth:50;' +
    '  body.scrollLeft=curp.offsetLeft-off;}' +
    ' [...body.querySelectorAll("td.cell")].forEach(td=>{td.onclick=()=>openEdit(Number(td.dataset.ri),Number(td.dataset.ci));});' +
    ' const r=curRec.r;const dirEl=document.getElementById("rec-dir");' +
    ' if(dirEl){' +
    '  if(r.lat!==null&&r.lng!==null){' +
    '   const dirBase="https://www.google.com/maps/dir/?api=1&destination="+r.lat+","+r.lng+"&travelmode=";' +
    '   dirEl.innerHTML="<div class=dirrow style=\\"margin-top:0;\\">"+' +
    '    "<a class=dirlink href=\\""+dirBase+"walking\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb6 徒歩</a>"+' +
    '    "<a class=dirlink href=\\""+dirBase+"bicycling\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb2 自転車</a>"+' +
    '    "<a class=dirlink href=\\""+dirBase+"driving\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\ude97 車</a></div>";' +
    '   dirEl.style.display="block";' +
    '  }else{' +
    '   dirEl.style.display="none";' +
    '  }' +
    ' }}' +
    'function openEdit(ri,ci){try{history.pushState({m:"edit"},"");}catch(e){}' +
    ' const room=curRec.data.rooms[ri];const cell=room.cells[ci];' +
    ' curEdit={ri:ri,ci:ci,chosen:cell.result||"",clearMode:false};' +
    ' document.getElementById("edittitle").textContent=room.room+"号室　"+periodLabel(ci);' +
    ' const rr=document.getElementById("resrow");rr.innerHTML="";' +
    ' function pickResult(btn,name,isClear){curEdit.chosen=isClear?"":name;curEdit.clearMode=!!isClear;[...rr.children].forEach(x=>x.classList.remove("on"));btn.classList.add("on");' +
    '  const d=document.getElementById("editdate");if(isClear){d.value="";}else if(!d.value){d.value=todayStr||"";}syncDatePickerFromText();}' +
    ' RESULTS.forEach(name=>{const b=document.createElement("button");b.className="resbtn"+(name===cell.result?" on":"");b.textContent=name;' +
    '  b.onclick=()=>pickResult(b,name,false);rr.appendChild(b);});' +
    ' if(cell.result||cell.date){const clearBtn=document.createElement("button");clearBtn.className="resbtn clear";clearBtn.textContent="クリア";' +
    '  clearBtn.onclick=()=>pickResult(clearBtn,"",true);rr.appendChild(clearBtn);}' +
    ' editDateInput.value=cell.date||"";syncDatePickerFromText();' +
    ' document.getElementById("edit").style.display="block";}' +
    'function periodLabel(ci){const periods=["1〜3月","4〜6月","7〜9月","10〜12月"];const reps=["1回目","2回目","3回目"];' +
    ' return periods[Math.floor(ci/3)]+" "+reps[ci%3];}' +
    'function closeEdit(){document.getElementById("edit").style.display="none";curEdit=null;}' +
    'window.addEventListener("popstate",()=>{' +
    ' const ed=document.getElementById("edit");if(ed&&ed.style.display==="block"){closeEdit();return;}' +
    ' const rc=document.getElementById("rec");if(rc&&rc.style.display==="block"){closeRec();return;}' +
    '});' +
    'function doSave(){if(!curEdit)return;const room=curRec.data.rooms[curEdit.ri];const cell=room.cells[curEdit.ci];' +
    ' const newResult=curEdit.clearMode?"":(curEdit.chosen||"");const newDate=curEdit.clearMode?"":document.getElementById("editdate").value.trim();' +
    ' if(curEdit.clearMode&&!cell.result&&!cell.date){closeEdit();return;}' +
    ' if(curEdit.clearMode&&!confirm("このマスの記録を消去しますか？"))return;' +
    ' const btn=document.getElementById("save");btn.disabled=true;btn.textContent="保存中…";' +
    ' google.script.run.withSuccessHandler(res=>{btn.disabled=false;btn.textContent="保存";' +
    '   if(res&&res.ok){cell.result=res.saved.result;cell.date=res.saved.date;closeEdit();renderRec();}' +
    '   else if(res&&res.conflict){alert("他の人が先に入力したようです。\\n現在の値: "+(res.current.result||"（空）")+" / "+(res.current.date||"（空）")+"\\n最新の状態に更新します。");' +
    '    closeEdit();openRec(curRec.r);}' +
    '   else{alert("保存に失敗しました: "+(res&&res.error?res.error:"不明なエラー"));}' +
    '  }).withFailureHandler(err=>{btn.disabled=false;btn.textContent="保存";alert(friendlyErr(err,true));})' +
    '  .saveVisitRecord({url:curRec.r.url,rowTop:room.rowTop,cellIndex:curEdit.ci,result:newResult,date:newDate,expectResult:cell.result,expectDate:cell.date});}' +
    'function safeReload(){const a=document.createElement("a");a.href=WEBAPP_URL;a.target="_top";document.body.appendChild(a);a.click();a.remove();}' +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function friendlyErr(err,forWrite){const m=String(err);const p=m.indexOf("権限")!==-1||m.toLowerCase().indexOf("permission")!==-1||m.toLowerCase().indexOf("access")!==-1;return p?(forWrite?"権限がないため保存できませんでした。スプレッドシートの編集権限が必要ですので、この画面を区域の係にお見せください。":"権限がないため記録シートを開けませんでした。スプレッドシートの閲覧権限が必要ですので、この画面を区域の係にお見せください。"):m;}' +
    'function attemptLogin() {' +
    '  const errorEl = document.getElementById("login-error-msg");' +
    '  const loadingEl = document.getElementById("login-loading");' +
    '  errorEl.textContent = "";' +
    '  if(loadingEl) loadingEl.style.display = "flex";' +
    '  google.script.run.withSuccessHandler(res => {' +
    '    if (res && res.ok) {' +
    '      USER_EMAIL = res.email;' +
    '      DATA = res.data;' +
    '      const emailEl = document.getElementById("user-email");' +
    '      if (emailEl) {' +
    '        emailEl.innerHTML = "ログイン: <b>" + esc(res.name || res.email) + "</b> <a href=\\"#\\" onclick=\\"logout()\\" style=\\"display:none;color:var(--accent);margin-left:8px;text-decoration:none;\\">アカウント切替</a>";' +
    '      }' +
    '      document.getElementById("login-screen").style.display = "none";' +
    '      initApp();' +
    '      checkForUpdate_();' +
    '      setInterval(checkForUpdate_, 600000);' +
    '    } else {' +
    '      if(loadingEl) loadingEl.style.display = "none";' +
    '      const errMsg = res ? res.error : "ログインに失敗しました。";' +
    '      if (errMsg.indexOf("登録されていません") !== -1) {' +
    '        const showEmail = (res && res.email) ? res.email : "（不明）";' +
    '        errorEl.innerHTML = "<div style=\\"border:1px solid #f5c2c7;background:#f8d7da;color:#842029;border-radius:10px;padding:12px;margin-top:8px;font-size:14.5px;line-height:1.6;font-weight:normal;text-align:left;\\">" +' +
    '          "Googleアカウントが登録されていないか、設定が間違っています。<br>" +' +
    '          "<b style=\\"color:#b02a37;font-size:15px;\\">この画面を区域の係にお見せください。</b><br><br>" +' +
    '          "<div style=\\"background:#fff;border:1px solid #f5c2c7;border-radius:6px;padding:8px;text-align:center;font-size:16px;font-weight:800;text-decoration:underline;color:#202124;word-break:break-all;\\">" + esc(showEmail) + "</div>" +' +
    '          "</div>";' +
    '      } else {' +
    '        errorEl.textContent = errMsg;' +
    '      }' +
    '      document.getElementById("login-screen").style.display = "flex";' +
    '    }' +
    '  }).withFailureHandler(err => {' +
    '    if(loadingEl) loadingEl.style.display = "none";' +
    '    errorEl.textContent = "通信エラーが発生しました: " + err;' +
    '    document.getElementById("login-screen").style.display = "flex";' +
    '  }).getAppData();' +
    '}' +
    'function logout() {' +
    '  const ok = confirm("アカウントを切り替えますか？\\n\\n[OK]：別のGoogleアカウントに切り替える\\n[キャンセル]：Googleアカウントから完全にログアウトする");' +
    '  let targetUrl = "";' +
    '  if (ok) {' +
    '    targetUrl = "https://accounts.google.com/AccountChooser?continue=" + encodeURIComponent(WEBAPP_URL);' +
    '  } else {' +
    '    if (confirm("Googleアカウントから完全にログアウトしますか？\\n（Gmailやスプレッドシートなど他のGoogleサービスからも一時的にログアウトされます）")) {' +
    '      targetUrl = "https://accounts.google.com/Logout?continue=" + encodeURIComponent(WEBAPP_URL);' +
    '    }' +
    '  }' +
    '  if (targetUrl) {' +
    '    const a = document.createElement("a");' +
    '    a.href = targetUrl;' +
    '    a.target = "_top";' +
    '    document.body.appendChild(a);' +
    '    a.click();' +
    '    a.remove();' +
    '  }' +
    '}' +
    'let cachedLatestVersion = null;' +
    'function checkForUpdate_(cb){' +
    '  const btnVer=document.getElementById("btnVersion");' +
    '  google.script.run.withSuccessHandler(latest=>{' +
    '    cachedLatestVersion=latest;' +
    '    const hasUpdate=!!latest && latest!==CURRENT_VERSION;' +
    '    if(btnVer){' +
    '      btnVer.classList.toggle("update-available", hasUpdate);' +
    '      if(hasUpdate)btnVer.title="最新版("+latest+")があります。タップして更新";' +
    '      else btnVer.title="バージョン情報・更新履歴";' +
    '    }' +
    '    if(typeof cb==="function")cb(latest,hasUpdate);' +
    '  }).withFailureHandler(()=>{' +
    '    if(typeof cb==="function")cb(null,false);' +
    '  }).getServerVersion();' +
    '}' +
    'window.onload = () => {' +
    '  attemptLogin();' +
    '  checkForUpdate_();' +
    '  setInterval(checkForUpdate_,120000);' +
    '  document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkForUpdate_();});' +
    '  window.addEventListener("focus",checkForUpdate_);' +
    '};' +
    
    'const btnUpdate=document.getElementById("btnUpdate");' +
    'if(btnUpdate){' +
    '  btnUpdate.onclick=()=>{' +
    '    if(!confirm("各スプレッドシートからマンションデータを再読み込みし、マスターファイルを更新しますか？\\n（完了まで少し時間がかかります）"))return;' +
    '    const origText=btnUpdate.textContent;' +
    '    btnUpdate.disabled=true;btnUpdate.textContent="更新中…";' +
    '    const pollProgress=()=>{google.script.run.withSuccessHandler(p=>{' +
    '      if(p&&p.total>0&&!p.done)btnUpdate.textContent="更新中…"+p.current+"/"+p.total;' +
    '    }).withFailureHandler(()=>{}).getMergeProgress();};' +
    '    const pollTimer=setInterval(pollProgress,1500);pollProgress();' +
    '    google.script.run.withSuccessHandler(res=>{' +
    '      clearInterval(pollTimer);' +
    '      if(res&&res.ok){' +
    '        alert(res.message);' +
    '        safeReload();' +
    '      } else {' +
    '        btnUpdate.disabled=false;btnUpdate.textContent=origText;' +
    '        alert("更新に失敗しました: "+(res&&res.error?res.error:"不明なエラー"));' +
    '      }' +
    '    }).withFailureHandler(err=>{' +
    '      clearInterval(pollTimer);' +
    '      btnUpdate.disabled=false;btnUpdate.textContent=origText;' +
    '      alert("通信エラーが発生しました: "+err);' +
    '    }).runMasterUpdate();' +
    '  };' +
    '}' +
    'const btnPortal=document.getElementById("btnPortal");' +
    'if(btnPortal){' +
    '  btnPortal.addEventListener("click",()=>{try{saveState();}catch(e){}});' +
    '}' +
    'const btnVersion=document.getElementById("btnVersion");' +
    'if(btnVersion){' +
    '  btnVersion.onclick=()=>{' +
    '    const notesBody=' +
    '      "【最近の更新内容】\\n" +' +
    '      "・v1.11.18: バージョンモーダルを新設し、最新版がある場合のみモーダル内に「最新版に更新」ボタンを表示するよう改善。\\n" +' +
    '      "・v1.11.17: ヘッダーのバージョン表示で最新版の存在を赤く通知する機能を追加。\\n" +' +
    '      "・v1.11.16: ピン表示メニューを開いた際に地図の拡大縮小（＋ー）ボタンが手前に被る問題を修正（背面に配置）。\\n" +' +
    '      "・v1.11.15: 登戸区域地図オーバーレイ（微調整機能・透過率記憶）、背景写真/地図の独立切替、ピン表示複数選択、検索窓と区域サイト配置を最適化。\\n" +' +
    '      "・v1.11.14.014: 「区域」「写真」レイヤー選択パネルに「完了」ボタンを追加（ピン表示と同じ操作で閉じられます）。\\n" +' +
    '      "・v1.11.14.013: 「写真」「区域」レイヤーのパネルが「現在地」ボタンの下に隠れる問題を修正（最前面に表示）。\\n" +' +
    '      "・v1.11.14.012: 区域サイトを同じタブで開くよう変更（ブラウザの戻るボタンで元の画面・検索条件・地図位置のまま復帰）。\\n" +' +
    '      "・v1.11.14.011: 区域サイトを別タブで確実に開くよう修正（アプリの画面は裏でそのまま維持され再起動なしで復帰可能）。\\n" +' +
    '      "・v1.11.14.010: 区域サイトをアプリ内全画面ビューで開き、ブラウザの戻るボタンで再起動せずに即座に復帰できるよう改善。\\n" +' +
    '      "・v1.11.14.009: 検索窓重複解消、検索窓2/3化＋区域サイトリンク横配置、ピン表示複数選択ドロップダウン対応。\\n" +' +
    '      "・v1.11.14.008: ピン表示切替とエリア選択をプルダウンに統合し、件数表示箇所へ集約。ヘッダーを1行削減し地図表示領域を拡大。\\n" +' +
    '      "・v1.11.14.007: 区域地図と衛星写真のレイヤーボタンを上下に分離配置。透過率の初期値を50%とし端末記憶に対応。\\n" +' +
    '      "・v1.11.14.006: 登戸区域地図8画像の初期座標（初期位置・拡大縮小幅・縦横比）を微調整済みの確定値に更新。\\n" +' +
    '      "・v1.11.14.005: 矢印キー移動量を半減（約5m微調整化）、拡大縮小も1%刻み化。座標コピーに拡大縮小幅・中心・移動量等の全数値を含めるよう拡張。\\n" +' +
    '      "・v1.11.14.004: 位置微調整モーダルをコンパクト化（サイズ・比率調整を折りたたみ化し、位置移動と横並びレイアウトに変更して地図視認性を向上）。\\n" +' +
    '      "・v1.11.14.003: 調整モーダル内に透過率スライダーと「調整した座標をコピー」ボタンを追加、矢印ボタン等のテキスト選択を防止。\\n" +' +
    '      "・v1.11.14.002: 位置微調整モーダルを画面最上部へ移動し、誤タッチ防止のため全操作ボタンを大型化。\\n" +' +
    '      "・v1.11.14.001: 登戸区域地図（8画像）のオーバーレイ重ね合わせ表示、透過率スライダー、位置微調整機能を追加。\\n" +' +
    '      "・v1.11.14: 背景地図切替（国土地理院の最新・年代別空中写真など13種）とピン非表示ボタン、区域サイトリンクを追加。\\n" +' +
    '      "・v1.11.13: バージョン番号の再カウントアップと更新通知・デプロイ確認のためのテストリリース（機能変更なし）。\\n" +' +
    '      "・v1.11.12: バージョン番号のカウントアップとデプロイ確認のためのテストリリース（機能変更なし）。\\n" +' +
    '      "・v1.11.11: 保護シート判定の誤検知を修正し、除外範囲などで実際は編集可能な記録シートも正しく保存できるように変更。\\n" +' +
    '      "・v1.11.10: 新しいバージョンが公開されると、画面上部のバージョン表示が赤くなり、タップすると更新内容と再起動確認を表示する機能を追加。\\n" +' +
    '      "・v1.11.9: 地図ピンの「訪問記録を開く」ボタンを、訪問拒否の建物ではグレーアウトして遷移できないように変更。\\n" +' +
    '      "・v1.11.8: 保護された記録シートについて、編集権限が無いユーザーでも閲覧はできるように変更（保存は引き続きブロック）。\\n" +' +
    '      "・v1.11.7: 黒塗り検知による訪問拒否の反映を、初回検知時のみ更新履歴に記録するよう変更（同じ検知が毎回記録される問題を解消）。\\n" +' +
    '      "・v1.11.6: マスター更新中の進行状況を、シート画面のトースト通知とWebアプリの「マスター更新」ボタン表示（件数）で確認できるように変更。\\n" +' +
    '      "・v1.11.5: マスター更新時に、座標キャッシュに無い住所を自動でジオコーディングして追加し、追加内容（エリア・マンション名・住所）を更新履歴に記録する機能を追加。\\n" +' +
    '      "・v1.11.4: マンション一覧の黒塗りセルから訪問拒否を自動検知してマスターへ反映し、拒否の建物は地図上に×アイコンで表示する機能を追加。\\n" +' +
    '      "・v1.11.3: マスター更新（今すぐ更新）実行時に、実行日時と結果を「更新履歴」シートへ自動記録する機能を追加。\\n" +' +
    '      "・v1.11.2: 高速動作を優先し、保護シートについても地図上ピン表示の仕様を維持（バージョン管理更新）。\\n" +' +
    '      "・v1.11.1: 保護された記録シートをアプリから開いたり保存したりできないように変更。\\n" +' +
    '      "・v1.11.0: 訪問記録モーダルの下部に徒歩・自転車・車でのルート案内ボタンを追加。\\n" +' +
    '      "・v1.10.0: アカウント切り替えボタン（リンク）を一時的に非表示に変更。\\n" +' +
    '      "・v1.9.8: マンションページの「マンション名」のフォントサイズを「現在日時」と同等の大きさに拡大。\\n" +' +
    '      "・v1.9.7: マンションページの現在日時表示を大きくし、秒までリアルタイム更新する機能を追加。\\n" +' +
    '      "・v1.9.6: マンションページ上部に現在日時（曜日付き）および現在時刻を表示する機能を追加。\\n" +' +
    '      "・v1.9.5: 閲覧・編集権限エラー発生時に、現在ログイン中のアカウントアドレスを大きく表示する機能を追加。\\n" +' +
    '      "・v1.9.4: スプレッドシートの権限エラー発生時に、区域の係への問い合わせを促すメッセージを追加。\\n" +' +
    '      "・v1.9.3: アカウント切り替え時のリダイレクトバグ（iframe内URL問題）を修正。\\n" +' +
    '      "・v1.9.2: 変更履歴ダイアログの更新。\\n" +' +
    '      "・v1.9.1: アカウント切り替え機能（別のGoogleアカウントの選択やログアウト機能）を追加。\\n" +' +
    '      "・v1.9.0: スプレッドシートのバージョン履歴に編集者を残すため、Google認証（ユーザー実行）方式へ移行。\\n" +' +
    '      "・v1.8.7: 未登録メールアドレス入力時のエラー表示を改善。連絡先（係）への提示を促す親切なエラーメッセージに変更。\\n" +' +
    '      "・v1.8.6: LocalStorageが機能しない環境に備え、Cookieによる二重保存・自動ログインに対応。\\n" +' +
    '      "・v1.8.5: 起動時のログイン画面での前回アドレスの即時自動入力（プリフィル）と、オートフィル属性・Enterキーログインに対応。\\n" +' +
    '      "・v1.8.4: ピンポップアップ内の各ボタンの縦幅（パディング）を広げ、年配の方でも誤タップしにくい大きなサイズに改善。\\n" +' +
    '      "・v1.8.3: マップ上のピンポップアップに「閉じる」ボタンを追加し、訪問記録を開くボタンと並べて配置。\\n" +' +
    '      "・v1.8.2: 起動時のログイン画面にバージョン番号を表示。訪問記録の部屋（号室）列を画面左端に隙間なく固定。\\n" +' +
    '      "・v1.8.1: 訪問記録の読込中ロゴを本来のドアとピンのアイコンに復元。訪問記録ポップアップの全画面表示・不透過化（最大化）を適用。\\n" +' +
    '      "・v1.8.0: 共通アクセスキーを廃止し、メールアドレスのみでログインできるように改修（1箇所入力化）。管理シートもメールアドレスのみのシンプルな構成に変更。\\n" +' +
    '      "・v1.7.3: URLパラメータによる自動ログイン（key, email）に対応。\\n" +' +
    '      "・v1.7.2: 訪問記録シートの読み込み・保存の動作不具合（ヘッダーエラー）を修正し、本来の1部屋2行パーサーに復元。世帯ピンの色（赤）を復元。";' +
    '    const vModal=document.getElementById("versionModal");' +
    '    const vStatus=document.getElementById("vmodalStatus");' +
    '    const vBody=document.getElementById("vmodalBody");' +
    '    const vBtnUpdate=document.getElementById("vmodalUpdate");' +
    '    if(!vModal)return;' +
    '    if(vBody)vBody.textContent=notesBody;' +
    '    vModal.style.display="flex";' +
    '    const applyStatus=(latest)=>{' +
    '      const hasUpdate=!!latest && latest!==CURRENT_VERSION;' +
    '      if(vStatus){' +
    '        vStatus.className="vmodal-status " + (hasUpdate?"has-update":"is-latest");' +
    '        vStatus.textContent=hasUpdate ? ("🆕 最新版あり ("+CURRENT_VERSION+" → "+latest+")") : ("✅ 最新版をご利用中です ("+CURRENT_VERSION+")");' +
    '      }' +
    '      if(vBtnUpdate){' +
    '        vBtnUpdate.style.display=hasUpdate?"inline-block":"none";' +
    '      }' +
    '    };' +
    '    if(cachedLatestVersion)applyStatus(cachedLatestVersion);' +
    '    checkForUpdate_((latest)=>{applyStatus(latest);});' +
    '  };' +
    '}' +
    'const vModal=document.getElementById("versionModal");' +
    'const vClose=document.getElementById("vmodalClose");' +
    'const vCloseIcon=document.getElementById("vmodalCloseIcon");' +
    'const vBtnUpdate=document.getElementById("vmodalUpdate");' +
    'if(vClose)vClose.onclick=()=>{if(vModal)vModal.style.display="none";};' +
    'if(vCloseIcon)vCloseIcon.onclick=()=>{if(vModal)vModal.style.display="none";};' +
    'if(vModal)vModal.onclick=(e)=>{if(e.target===vModal)vModal.style.display="none";};' +
    'if(vBtnUpdate)vBtnUpdate.onclick=()=>{vBtnUpdate.disabled=true;vBtnUpdate.textContent="更新中…";safeReload();};' +
    '</script></body></html>';
}
