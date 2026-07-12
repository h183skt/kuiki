/**
 * 区域マンション一覧 ウェブアプリ（webapp.gs v1.3.0 複数ワークシート動的取得・タブ切り替え対応）
 * - 「保存」でセル（結果）とその真下（日付）に書き込みます。
 * - B列（最終訪問日）は保護されている可能性があるため更新しません。
 * v4.1からの追加点:
 * ・統合シートJ列に登録されているシートURL以外は、読み取り・保存できないようにしました。
 * ・保存時に、結果・行・列の検証を追加しました。
 * ・今日の日付をクライアント側でも仮生成し、サーバー取得前でも日付が入るようにしました。
 *
 * 更新手順:
 * 1. webapp ファイルの中身をこのコードで丸ごと置き換えて保存
 * 2. 「デプロイ > デプロイを管理 > 鉛筆 > 新バージョン」で更新
 */

const WEBAPP = {
  SHEET_NAME: '統合',
  COL_AREA: 1,
  COL_MAP: 2,
  COL_NAME: 3,
  COL_TYPE: 4,
  COL_ADDR: 5,
  COL_URL: 10,

  TITLE: '区域マンション一覧',
  VERSION: 'v1.3.0',
  OPEN_IN_APP: false,
  CACHE_SHEET: '座標キャッシュ',
  ICON_URL: 'https://5d5f3d7a.png-cdu.pages.dev/area_door_pin_icon_180.png',

  TYPE_COLORS: {
    '単身': '#1a73e8',
    '世帯': '#d93025',
    '混在': '#f9ab00'
  },
  DEFAULT_COLOR: '#5f6368',

  REC_DATA_START_ROW: 6,
  REC_ROOM_COL: 1,
  REC_PREV_COL: 2,
  REC_FIRST_VISIT_COL: 3,
  REC_VISIT_COLS: 12,
  REC_RESULTS: ['会えた', '留守', '空室', '投函のみ', '予約'],
  REC_PERIODS: ['1〜3月', '4〜6月', '7〜9月', '10〜12月'],
};

/* ============================================================
 * ジオコーディング（手動実行・進捗表示付き）
 * ============================================================ */

function geocodeAddresses() {
  const START = Date.now();
  const TIME_LIMIT_MS = 5 * 60 * 1000;
  const CHUNK = 25;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WEBAPP.SHEET_NAME);
  if (!sh) throw new Error('シート「' + WEBAPP.SHEET_NAME + '」が見つかりません。');

  let cache = ss.getSheetByName(WEBAPP.CACHE_SHEET);
  if (!cache) {
    cache = ss.insertSheet(WEBAPP.CACHE_SHEET);
    cache.getRange(1, 1, 1, 4).setValues([['住所', '緯度', '経度', '状態']]);
  }

  const known = {};
  const cLast = cache.getLastRow();
  if (cLast >= 2) {
    cache.getRange(2, 1, cLast - 1, 1).getDisplayValues().forEach(row => {
      known[row[0]] = true;
    });
  }

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    ss.toast('統合シートにデータがありません。', '座標取得', 8);
    return;
  }

  const addrs = sh.getRange(2, WEBAPP.COL_ADDR, lastRow - 1, 1).getDisplayValues();
  const targets = [];
  const seen = {};

  addrs.forEach(row => {
    const a = row[0];
    if (a && !known[a] && !seen[a]) {
      seen[a] = true;
      targets.push(a);
    }
  });

  if (targets.length === 0) {
    ss.toast('新しい住所はありません。キャッシュは最新です。', '座標取得', 8);
    return;
  }

  const total = targets.length;
  ss.toast('0 / ' + total + ' 件　開始します…', '座標取得中', -1);

  const geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('jp');
  let buffer = [];
  let done = 0;
  let ok = 0;
  let ng = 0;
  let stoppedEarly = false;

  for (let i = 0; i < total; i++) {
    if (Date.now() - START > TIME_LIMIT_MS) {
      stoppedEarly = true;
      break;
    }

    const addr = targets[i];
    let lat = '';
    let lng = '';
    let status = 'NG';

    try {
      const res = geocoder.geocode(normAddr_(addr));
      if (res.status === 'OK' && res.results.length > 0) {
        const loc = res.results[0].geometry.location;
        lat = loc.lat;
        lng = loc.lng;
        status = 'OK';
        ok++;
      } else {
        ng++;
      }
    } catch (e) {
      ng++;
    }

    buffer.push([addr, lat, lng, status]);
    done++;

    if (buffer.length >= CHUNK) {
      flushCache_(cache, buffer);
      buffer = [];
      const pct = Math.round(done / total * 100);
      ss.toast(done + ' / ' + total + ' 件（' + pct + '%）　成功 ' + ok + ' / 失敗 ' + ng, '座標取得中', -1);
    }

    Utilities.sleep(100);
  }

  if (buffer.length > 0) flushCache_(cache, buffer);

  if (stoppedEarly) {
    const remain = total - done;
    ss.toast(
      '時間制限のため途中保存して中断しました（処理済 ' + done + ' / 残り ' + remain + ' 件）。もう一度実行すると続きから処理します。',
      '座標取得 一時中断',
      -1
    );
  } else {
    ss.toast(
      '完了: 成功 ' + ok + ' 件 / 失敗 ' + ng + ' 件' + (ng > 0 ? '（失敗分は座標キャッシュの状態=NG行）' : ''),
      '座標取得 完了',
      -1
    );
  }
}

function flushCache_(cache, buffer) {
  cache.getRange(cache.getLastRow() + 1, 1, buffer.length, 4).setValues(buffer);
  SpreadsheetApp.flush();
}

function normAddr_(s) {
  return String(s)
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[−ー―‐－]/g, '-')
    .replace(/\s+/g, '');
}


function cleanErrorMessage_(e) {
  return String((e && e.message) ? e.message : e || '')
    .replace(/^(Exception|Error):\s*/, '')
    .trim();
}

function isPermissionErrorMessage_(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();

  return lower.indexOf('permission') !== -1 ||
    lower.indexOf('access denied') !== -1 ||
    lower.indexOf('not have permission') !== -1 ||
    lower.indexOf('insufficient permissions') !== -1 ||
    text.indexOf('権限') !== -1 ||
    text.indexOf('アクセスが拒否') !== -1;
}

function friendlySheetAccessError_(e, purpose) {
  const message = cleanErrorMessage_(e);

  if (isPermissionErrorMessage_(message)) {
    return purpose === 'write'
      ? '権限がないため保存できませんでした。対象のスプレッドシートで編集権限があるか確認し、権限付与後にもう一度お試しください。'
      : '権限がないため記録シートを開けませんでした。対象のスプレッドシートで閲覧権限があるか確認し、権限付与後にもう一度お試しください。';
  }

  return message || '不明なエラーが発生しました。';
}

/* ============================================================
 * 訪問記録 読み取り
 * ============================================================ */

function getVisitRecords(url) {
  try {
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

    const ss = SpreadsheetApp.openById(ids.fileId);
    const allSheets = ss.getSheets();
    const sheetsData = [];

    for (let s = 0; s < allSheets.length; s++) {
      const sheet = allSheets[s];
      const sheetName = sheet.getName();

      if (sheetName === 'マンション一覧' || sheetName === '設定' || sheetName === '座標キャッシュ') {
        continue;
      }

      const lastRow = sheet.getLastRow();
      const start = WEBAPP.REC_DATA_START_ROW;
      const rooms = [];

      if (lastRow >= start) {
        const numRows = lastRow - start + 1;
        const firstCol = WEBAPP.REC_ROOM_COL;
        const numCols = WEBAPP.REC_FIRST_VISIT_COL - 1 + WEBAPP.REC_VISIT_COLS;
        const disp = sheet.getRange(start, firstCol, numRows, numCols).getDisplayValues();

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
      }

      sheetsData.push({
        sheetId: String(sheet.getSheetId()),
        sheetName: sheetName,
        rooms: rooms
      });
    }

    if (sheetsData.length === 0) {
      return {
        ok: false,
        error: '有効なワークシートが見つかりませんでした。'
      };
    }

    return {
      ok: true,
      sheets: sheetsData,
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

    const sheet = openSheetByUrl_(p.url, p.sheetId, 'write');
    if (!sheet) {
      return {
        ok: false,
        error: 'URLからシートを特定できませんでした。'
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
        ok: false,
        conflict: true,
        current: {
          result: curResult,
          date: curDate
        }
      };
    }

sheet.getRange(resultRow, col).setValue(newResult);
sheet.getRange(dateRow, col).setNumberFormat('@').setValue(newDate);

// B列（最終訪問日）は保護されている可能性があるため、Webアプリからは更新しません。

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
 * 共通: URL安全チェック・URLからシートを開く
 * ============================================================ */

function sheetKeyFromUrl_(url) {
  const ids = parseSheetUrl_(url);
  if (!ids) return '';
  return ids.fileId + ':' + String(ids.gid || '');
}

function getAllowedSheetKeys_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WEBAPP.SHEET_NAME);

  const allowed = {};
  if (!sh) return allowed;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return allowed;

  const urls = sh.getRange(2, WEBAPP.COL_URL, lastRow - 1, 1).getDisplayValues();

  urls.forEach(row => {
    const key = sheetKeyFromUrl_(row[0]);
    if (key) allowed[key] = true;
  });

  return allowed;
}

function isAllowedSheetUrl_(url) {
  const key = sheetKeyFromUrl_(url);
  if (!key) return false;

  const allowed = getAllowedSheetKeys_();
  return allowed[key] === true;
}

function openSheetByUrl_(url, sheetIdOrPurpose, purpose) {
  let sheetId = null;
  let actualPurpose = sheetIdOrPurpose;
  if (typeof sheetIdOrPurpose === 'string' && sheetIdOrPurpose !== 'read' && sheetIdOrPurpose !== 'write') {
    sheetId = sheetIdOrPurpose;
    actualPurpose = purpose;
  }

  const ids = parseSheetUrl_(url);
  if (!ids) return null;

  const ss = SpreadsheetApp.openById(ids.fileId);
  const targetGid = sheetId !== null ? sheetId : ids.gid;

  if (targetGid !== null) {
    const all = ss.getSheets();

    for (let i = 0; i < all.length; i++) {
      if (String(all[i].getSheetId()) === String(targetGid)) {
        return all[i];
      }
    }
  }

  return ss.getSheets()[0];
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
    const isPermission = isPermissionErrorMessage_(msg);
    const body = isPermission
      ? 'このページを表示する権限がありません。スプレッドシートの閲覧権限があるアカウントでアクセスしてください。'
      : ('エラーが発生しました: ' + msg);
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WEBAPP.SHEET_NAME);

  if (!sh) {
    return HtmlService.createHtmlOutput('シート「' + WEBAPP.SHEET_NAME + '」が見つかりません。');
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
        url: display[r][WEBAPP.COL_URL - 1],
        map: urlFromFormula_(formulas[r][WEBAPP.COL_MAP - 1]),
        lat: c ? c[0] : null,
        lng: c ? c[1] : null,
      });
    }
  }

  const dataJson = JSON.stringify(rows).replace(/</g, '\\u003c');
  const colorsJson = JSON.stringify(WEBAPP.TYPE_COLORS);
  const resultsJson = JSON.stringify(WEBAPP.REC_RESULTS);

  return HtmlService.createHtmlOutput(buildHtml_(dataJson, colorsJson, resultsJson))
    .setTitle(WEBAPP.TITLE)
    .setFaviconUrl(WEBAPP.ICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function urlFromFormula_(formula) {
  if (!formula) return '';

  const m = String(formula).match(/^=HYPERLINK\(\s*"([^"]+)"/i);
  return m ? m[1] : '';
}

function buildHtml_(dataJson, colorsJson, resultsJson) {
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">' +
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>' +
    '<style>' +
    ':root{--accent:#1a73e8;--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--text:#202124;--sub:#5f6368;--green:#34a853;}' +
    '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}' +
    'html,body{margin:0;height:100%;}' +
    'body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;}' +
    'header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 12px;z-index:1001;}' +
    '.topbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;}' +
    'h1{font-size:16px;margin:0;flex:1;}' +
    '.ver{font-size:11px;color:var(--sub);background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:2px 7px;margin-right:4px;white-space:nowrap;}' +
    '.toggle{display:flex;border:1px solid var(--accent);border-radius:8px;overflow:hidden;}' +
    '.toggle button{font-size:13px;padding:6px 14px;border:0;background:var(--card);color:var(--accent);}' +
    '.toggle button.on{background:var(--accent);color:#fff;}' +
    '#q{width:100%;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);}' +
    '#areas{display:flex;gap:6px;overflow-x:auto;padding:8px 0 2px;-webkit-overflow-scrolling:touch;}' +
    '#areas button{flex:0 0 auto;font-size:13px;padding:6px 12px;border-radius:16px;border:1px solid var(--line);background:var(--card);color:var(--sub);}' +
    '#areas button.on{background:var(--accent);border-color:var(--accent);color:#fff;}' +
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
    '.pop .dirrow{display:flex;gap:5px;margin-top:7px;}' +
    '.pop .dirlink{flex:1;text-align:center;font-size:12px;font-weight:600;background:var(--green);color:#fff;border-radius:8px;padding:5px 4px;text-decoration:none;white-space:nowrap;}' +
    '.pop .recbtn{display:block;text-align:center;margin-top:5px;font-size:12px;font-weight:600;background:var(--accent);color:#fff;border-radius:8px;padding:5px;cursor:pointer;}' +
    '.pop .pbadge{display:inline-block;font-size:11px;background:#e8f0fe;color:var(--accent);border-radius:5px;padding:0 6px;font-weight:600;margin-bottom:3px;}' +
    '.me-wrap{position:relative;width:36px;height:40px;}' +
    '.me-pulse{position:absolute;left:50%;bottom:2px;transform:translateX(-50%);width:14px;height:14px;border-radius:50%;background:rgba(52,168,83,.9);animation:mepulse 1.6s ease-out infinite;}' +
    '@keyframes mepulse{0%{box-shadow:0 0 0 0 rgba(52,168,83,.6);}100%{box-shadow:0 0 0 22px rgba(52,168,83,0);}}' +
    '.me-emoji{position:absolute;left:50%;bottom:0;transform:translateX(-50%);font-size:34px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));}' +
    '.empty{text-align:center;color:var(--sub);padding:40px 0;}' +
    '#rec{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2000;display:none;}' +
    '#recinner{position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;}' +
    '#rechead{background:var(--card);border-bottom:1px solid var(--line);padding:10px 12px;display:flex;align-items:center;gap:10px;}' +
    '#rechead h2{font-size:16px;margin:0;flex:1;}' +
    '#recclose{font-size:14px;font-weight:600;color:var(--accent);background:none;border:1px solid var(--accent);border-radius:8px;padding:6px 12px;}' +
    '#recbody{flex:1;overflow:auto;padding:10px;}' +
    '.rectable{border-collapse:collapse;font-size:12px;white-space:nowrap;}' +
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
    '.rectable td.past-cell{background:#f1f3f4;color:#70757a;}' +
    '.tab-btn.on{background:var(--accent) !important;color:#fff !important;border-color:var(--accent) !important;font-weight:700;}' +
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
    '</style></head><body>' +
    '<header><div class="topbar"><h1>' + WEBAPP.TITLE + '</h1>' +
    '<span class="ver">' + WEBAPP.VERSION + '</span>' +
    '<div class="toggle"><button id="bList">一覧</button><button id="bMap" class="on">地図</button></div></div>' +
    '<input id="q" type="search" placeholder="マンション名・住所で検索" autocomplete="off">' +
    '<div id="areas"></div><div id="count"></div></header>' +
    '<main id="list"></main>' +
    '<div id="mapwrap"><div id="map"></div><button id="locate">現在地</button></div>' +
    '<div id="rec"><div id="recinner"><div id="rechead"><h2 id="rectitle">訪問記録</h2><button id="recclose">閉じる</button></div><div id="recbody"></div></div></div>' +
    '<div id="edit"><div id="editbox">' +
    '<div class="edithead"><p id="edittitle">記録</p><button id="editclose" aria-label="閉じる">×</button></div>' +
    '<div class="resrow" id="resrow"></div>' +
    '<div class="daterow"><label>日付</label><input id="editdate" type="text" placeholder="例 6/14 (土)"><div class="todaywrap"><button id="today" type="button">日付選択</button><input id="editdatepick" type="date" aria-label="日付を選択"></div></div>' +
    '<div class="btnrow"><button id="save">保存</button></div>' +
    '</div></div>' +
    '<script>' +
    'const DATA=' + dataJson + ';' +
    'const COLORS=' + colorsJson + ';' +
    'const RESULTS=' + resultsJson + ';' +
    'const DEFC="' + WEBAPP.DEFAULT_COLOR + '";' +
    'const STANDALONE=(navigator.standalone===true)||window.matchMedia("(display-mode: standalone)").matches;' +
    'let curArea="";let curQ="";let mode="map";let map=null;let layer=null;let curSheetIndex=0;' +
    'let watchId=null;let meMarker=null;let meCircle=null;let lastPos=null;let firstFix=true;' +
    'let savedView=null;' +
    'let curRec=null;' +
    'let curEdit=null;' +
    'function pad2(n){return String(n).padStart(2,"0");}' +
    'function localTodayLabel(){const d=new Date();const w=["日","月","火","水","木","金","土"][d.getDay()];return (d.getMonth()+1)+"/"+d.getDate()+" ("+w+")";}' +
    'function localTodayIso(){const d=new Date();return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate());}' +
    'function labelFromIsoDate(s){const m=String(s||"").match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);if(!m)return "";const y=Number(m[1]),mo=Number(m[2]),da=Number(m[3]);const w=["日","月","火","水","木","金","土"][new Date(y,mo-1,da).getDay()];return mo+"/"+da+" ("+w+")";}' +
    'function isoFromDisplayDate(s){const t=String(s||"").trim();if(!t)return "";if(/^\\d{4}-\\d{2}-\\d{2}$/.test(t))return t;const m=t.match(/^(\\d{1,2})\\/(\\d{1,2})/);if(!m)return "";const y=(new Date()).getFullYear(),mo=Number(m[1]),da=Number(m[2]),dt=new Date(y,mo-1,da);if(dt.getFullYear()!==y||dt.getMonth()+1!==mo||dt.getDate()!==da)return "";return y+"-"+pad2(mo)+"-"+pad2(da);}' +
    'let todayStr=localTodayLabel();' +
    'google.script.run.withSuccessHandler(s=>{if(s)todayStr=s;}).getTodayLabel();' +
    'function saveState(){try{sessionStorage.setItem("st",JSON.stringify({a:curArea,q:curQ,m:mode,v:savedView}));}catch(e){}}' +
    'let initMode="map";' +
    'try{const st=JSON.parse(sessionStorage.getItem("st")||"{}");curArea=st.a||"";curQ=st.q||"";if(st.v)savedView=st.v;}catch(e){}' +
    'const areas=[...new Set(DATA.map(r=>r.area))];' +
    'const areaBox=document.getElementById("areas");' +
    'function chip(label,val){const b=document.createElement("button");b.textContent=label;b.dataset.val=val;b.onclick=()=>{curArea=val;render();};areaBox.appendChild(b);}' +
    'chip("すべて","");areas.forEach(a=>chip(a.replace(/エリア$/,""),a));' +
    'document.getElementById("q").addEventListener("input",e=>{curQ=e.target.value.trim();render();});' +
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
    '  if(!meMarker){meCircle=L.circle(lastPos,{radius:acc,color:"#34a853",weight:1,fillColor:"#34a853",fillOpacity:0.12}).addTo(map);' +
    '   const meIcon=L.divIcon({className:"",html:"<div class=me-wrap><div class=me-pulse></div><div class=me-emoji>\\ud83d\\udccd</div></div>",iconSize:[36,40],iconAnchor:[18,38]});' +
    '   meMarker=L.marker(lastPos,{icon:meIcon,zIndexOffset:1000}).addTo(map);' +
    '  }else{meMarker.setLatLng(lastPos);meCircle.setLatLng(lastPos);meCircle.setRadius(acc);}' +
    '  if(firstFix){firstFix=false;map.setView(lastPos,16);}' +
    ' },err=>{stopLocate();if(err.code===1)alert("位置情報の利用が許可されていません。");else alert("現在地を取得できませんでした（"+err.message+"）");' +
    ' },{enableHighAccuracy:true,maximumAge:5000,timeout:15000});}' +
    'function stopLocate(){if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;}document.getElementById("locate").classList.remove("on");}' +
    'function hits_(){const q=curQ.toLowerCase();return DATA.filter(r=>(!curArea||r.area===curArea)&&(!q||r.name.toLowerCase().includes(q)||r.addr.toLowerCase().includes(q)));}' +
    'function render(){[...areaBox.children].forEach(b=>b.classList.toggle("on",b.dataset.val===curArea));' +
    ' const hits=hits_();document.getElementById("count").textContent=hits.length+" 件"+(mode==="map"?"（ピン "+hits.filter(r=>r.lat!==null).length+"）":"");' +
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
    ' L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap"}).addTo(map);' +
    ' layer=L.layerGroup().addTo(map);' +
    ' if(savedView&&savedView.c){map.setView(savedView.c,savedView.z);}else{map.setView([35.62,139.57],14);}' +
    ' map.on("moveend",()=>{savedView={c:[map.getCenter().lat,map.getCenter().lng],z:map.getZoom()};saveState();});}' +
    'function renderMap(hits){if(!map)return;layer.clearLayers();const pts=[];' +
    ' hits.forEach(r=>{if(r.lat===null)return;pts.push([r.lat,r.lng]);const col=COLORS[r.type]||DEFC;' +
    '  const mk=L.circleMarker([r.lat,r.lng],{radius:9,color:"#fff",weight:2,fillColor:col,fillOpacity:0.95});' +
    '  const dirBase="https://www.google.com/maps/dir/?api=1&destination="+r.lat+","+r.lng+"&travelmode=";' +
    '  const dirBtns="<div class=dirrow>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"walking\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb6 徒歩</a>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"bicycling\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\udeb2 自転車</a>"+' +
    '   "<a class=dirlink href=\\""+dirBase+"driving\\" target=\\"_blank\\" rel=\\"noopener\\">\\ud83d\\ude97 車</a></div>";' +
    '  const popId="rb_"+Math.random().toString(36).slice(2);' +
    '  mk.bindPopup("<div class=pop>"+(r.type?"<span class=pbadge>"+esc(r.type)+"</span><br>":"")+' +
    '   "<div class=pname>"+esc(r.name)+"</div><div class=paddr>"+esc(r.addr)+"</div>"+dirBtns+' +
    '   "<div class=recbtn id="+popId+">訪問記録を開く</div></div>");' +
    '  mk.on("popupopen",()=>{const el=document.getElementById(popId);if(el)el.onclick=()=>openRec(r);});' +
    '  mk.addTo(layer);});' +
    ' if(pts.length>0&&watchId===null&&!savedView)map.fitBounds(pts,{padding:[30,30],maxZoom:17});}' +
    'function openRec(r){curSheetIndex=0;const m=document.getElementById("rec");m.style.display="block";' +
    ' document.getElementById("rectitle").textContent=r.name;' +
    ' const body=document.getElementById("recbody");body.innerHTML="<p class=recnote>読み込み中…</p>";' +
    ' if(!r.url){body.innerHTML="<p class=recnote>この建物にはシートのURLが設定されていません。</p>";return;}' +
    ' google.script.run.withSuccessHandler(res=>{curRec={r:r,data:res};renderRec();}).withFailureHandler(err=>{' +
    '  body.innerHTML="<p class=recnote>"+esc(friendlyErr(err,false))+"</p>";}).getVisitRecords(r.url);}' +
    'function closeRec(){closeEdit();document.getElementById("rec").style.display="none";curRec=null;}' +
    'function currentPeriodIndex(){return Math.floor(new Date().getMonth()/3);}' +
    'function renderRec(){const body=document.getElementById("recbody");const res=curRec.data;' +
    ' if(!res||!res.ok){body.innerHTML="<p class=recnote>読み込みに失敗しました: "+esc(res&&res.error?res.error:"不明なエラー")+"</p>";return;}' +
    ' if(!res.sheets||res.sheets.length===0){body.innerHTML="<p class=recnote>部屋データが見つかりませんでした。</p>";return;}' +
    ' if(curSheetIndex>=res.sheets.length)curSheetIndex=0;' +
    ' const currentSheet=res.sheets[curSheetIndex];' +
    ' const periods=res.periods;const reps=["1回目","2回目","3回目"];const curPi=currentPeriodIndex();' +
    ' let h="";' +
    ' if(res.sheets.length>1){' +
    '   h+="<div class=\\"sheet-tabs\\" style=\\"display:flex;gap:6px;overflow-x:auto;padding:2px 2px 10px;margin-bottom:8px;border-bottom:1px solid var(--line);\\">";' +
    '   res.sheets.forEach((sh,idx)=>{' +
    '     const active=idx===curSheetIndex?"on":"";' +
    '     h+="<button class=\\"tab-btn "+active+"\\" data-idx="+idx+" style=\\"flex:0 0 auto;font-size:12px;padding:6px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--sub);cursor:pointer;\\">"+esc(sh.sheetName)+"</button>";' +
    '   });' +
    '   h+="</div>";' +
    ' }' +
    ' h+="<p class=recnote>セルをタップして記録を入力できます。</p>";' +
    ' h+="<table class=rectable><thead><tr><th class=rm>部屋</th>";' +
    ' periods.forEach((p,pi)=>{reps.forEach(rep=>{h+="<th"+(pi===curPi?" class=\\"curp\\"":"")+">"+esc(p)+"<br>"+rep+"</th>";});});' +
    ' h+="</tr></thead><tbody>";' +
    ' currentSheet.rooms.forEach((room,ri)=>{' +
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
    ' [...body.querySelectorAll(".tab-btn")].forEach(btn=>{btn.onclick=()=>{curSheetIndex=Number(btn.dataset.idx);renderRec();};});' +
    ' const curp=body.querySelector("th.curp");' +
    ' if(curp){const rm=body.querySelector("th.rm");const off=rm?rm.offsetWidth:50;' +
    '  body.scrollLeft=curp.offsetLeft-off;}' +
    ' [...body.querySelectorAll("td.cell")].forEach(td=>{td.onclick=()=>openEdit(Number(td.dataset.ri),Number(td.dataset.ci));});}' +
    'function openEdit(ri,ci){const currentSheet=curRec.data.sheets[curSheetIndex];const room=currentSheet.rooms[ri];const cell=room.cells[ci];' +
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
    'function doSave(){if(!curEdit)return;const currentSheet=curRec.data.sheets[curSheetIndex];const room=currentSheet.rooms[curEdit.ri];const cell=room.cells[curEdit.ci];' +
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
    '  .saveVisitRecord({url:curRec.r.url,sheetId:currentSheet.sheetId,rowTop:room.rowTop,cellIndex:curEdit.ci,result:newResult,date:newDate,expectResult:cell.result,expectDate:cell.date});}' +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function friendlyErr(err,forWrite){const m=String(err);const p=m.indexOf("権限")!==-1||m.toLowerCase().indexOf("permission")!==-1||m.toLowerCase().indexOf("access")!==-1;return p?(forWrite?"権限がないため保存できませんでした。対象のスプレッドシートで編集権限があるか確認し、権限付与後にもう一度お試しください。":"権限がないため記録シートを開けませんでした。対象のスプレッドシートで閲覧権限があるか確認し、権限付与後にもう一度お試しください。"):m;}' +
    'document.getElementById("q").value=curQ;' +
    'setMode(initMode);' +
    '</script></body></html>';
}
