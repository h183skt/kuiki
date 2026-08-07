// テスト用のブランチ開発テスト用コメント
/**
 * 区域スプレッドシート統合スクリプト（gidリンク＋URL列版）
 * 指定フォルダ内の各エリアのスプレッドシートを読み取り、
 * マスターの「統合」シートに「エリア名」列を付けてマージします。
 *
 * ・セル内のリンク（埋め込みリンク・HYPERLINK関数）を保持
 * ・「#gid=」だけの内部リンクは、元ファイルの完全URLに変換
 * ・I列: 各マンションのシートへのリンク（クリック用）
 * ・J列: 同じURLを裸のテキストとして出力（コピー・他用途用）
 *
 * 使い方:
 * 1. CONFIG.FOLDER_ID にフォルダIDを設定
 * 2. mergeAreaSheets を1回実行して認証
 * 3. 以後はシートのメニュー「区域訪問記録アプリ > 今すぐ更新」から実行
 */

const CONFIG = {
  // 「一時フォルダ」のID
  FOLDER_ID: '1QIxWM1P6znCjBT2V0BuoBAMNb9iByEAk',

  SOURCE_SHEET_NAME: 'マンション一覧', // 各ファイル内の読み取り対象シート名
  HEADER_ROW: 2,       // 見出し行
  DATA_START_ROW: 3,   // データ開始行
  FIRST_COLUMN: 1,     // A列
  LAST_COLUMN: 7,      // G列
  KEY_COLUMN_INDEX: 2, // 空行判定に使う列（範囲内の位置。2 = B列「マンション名」）

  // シートリンク（統合シートのI列・J列）
  LINK_SOURCE_COLUMN: 2,         // gid付きリンクを取り出す列（元ファイルのB列=マンション名）
  LINK_COLUMN_HEADER: 'シート',   // I列の見出し
  LINK_TEXT: 'シートへ',          // I列に表示する文字
  URL_COLUMN_HEADER: 'URL',      // J列の見出し

  // 訪問拒否の黒塗り検知（マンション一覧の行に黒背景セルがあれば拒否扱いにする）
  STATE_COLUMN_INDEX: 7,   // 拒否列の位置（範囲内の位置。7 = G列「拒否」）
  BLACKOUT_MARK: '〇',      // 黒塗り検知時に拒否列へ書き込む文字

  // 座標キャッシュ同期（統合シートにある住所で、座標キャッシュに無いものを追加する）
  ADDR_COLUMN_INDEX: 4,          // 住所列の位置（範囲内の位置。4 = D列「住所」）
  CACHE_SHEET_NAME: '座標キャッシュ', // webapp.gs の WEBAPP.CACHE_SHEET と同名

  OUTPUT_SHEET_NAME: '統合', // 出力先シート名（毎回全消去して書き直します）
  HISTORY_SHEET_NAME: '更新履歴', // 実行日時・内容を記録するシート（追記式）
};

/** シートを開いたときにメニューを追加 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('区域訪問記録アプリ')
    .addItem('今すぐ更新', 'mergeAreaSheets')
    .addToUi();
}

/** メイン処理 */
function mergeAreaSheets() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const masterId = SpreadsheetApp.getActiveSpreadsheet().getId();

  const files = [];
  const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() !== masterId) files.push(f);
  }
  if (files.length === 0) {
    throw new Error('フォルダ内にスプレッドシートが見つかりません。FOLDER_ID を確認してください。');
  }

  files.sort((a, b) => leadingNumber_(a.getName()) - leadingNumber_(b.getName()));

  const numCols = CONFIG.LAST_COLUMN - CONFIG.FIRST_COLUMN + 1;
  const totalCols = numCols + 3; // エリア列 + データ列 + シートリンク列 + URL列
  const merged = [];
  const warnings = [];
  const seenAreas = new Set();
  const addrInfo = new Map(); // 住所 -> { area, names: [マンション名, ...] }

  files.forEach(file => {
    const fileName = file.getName();
    // ファイル名に「テスト」という文字列が含まれている場合は統合から除外
    if (fileName.indexOf('テスト') !== -1) {
      return;
    }

    const areaName = fileName.replace(/\s*のコピー\s*$/, '').trim();
    const areaKey = leadingNumber_(fileName);

    if (seenAreas.has(areaKey)) {
      warnings.push('重複スキップ: ' + file.getName());
      return;
    }
    seenAreas.add(areaKey);

    let ss;
    try {
      ss = SpreadsheetApp.openById(file.getId());
    } catch (e) {
      warnings.push('開けません: ' + file.getName());
      return;
    }
    const sh = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
    if (!sh) {
      warnings.push('シート「' + CONFIG.SOURCE_SHEET_NAME + '」なし: ' + file.getName());
      return;
    }

    // 元ファイルのベースURL（gidを連結して完全URLを作る）
    const fileUrlBase = 'https://docs.google.com/spreadsheets/d/' + file.getId() + '/edit';

    const lastRow = sh.getLastRow();
    if (lastRow < CONFIG.DATA_START_ROW) return;

    const numRows = lastRow - CONFIG.DATA_START_ROW + 1;
    const range = sh.getRange(CONFIG.DATA_START_ROW, CONFIG.FIRST_COLUMN, numRows, numCols);

    const values = range.getValues();
    const display = range.getDisplayValues();
    const richText = range.getRichTextValues();
    const formulas = range.getFormulas();
    const backgrounds = range.getBackgrounds();

    let noGid = 0;
    let blackoutFilled = 0;

    for (let r = 0; r < numRows; r++) {
      const keyVal = values[r][CONFIG.KEY_COLUMN_INDEX - 1];
      if (keyVal === '' || keyVal === null) continue;

      const row = [areaName];
      for (let c = 0; c < numCols; c++) {
        let url = extractUrl_(richText[r][c], formulas[r][c]);
        if (url) {
          url = toFullUrl_(url, fileUrlBase); // 内部リンク(#gid=…)は完全URL化
          const text = String(display[r][c]).replace(/"/g, '""');
          row.push('=HYPERLINK("' + url.replace(/"/g, '""') + '","' + text + '")');
        } else {
          row.push(values[r][c]);
        }
      }

      const addrText = display[r][CONFIG.ADDR_COLUMN_INDEX - 1];
      const nameText = display[r][CONFIG.KEY_COLUMN_INDEX - 1];
      if (addrText) {
        if (!addrInfo.has(addrText)) addrInfo.set(addrText, { area: areaName, names: [] });
        addrInfo.get(addrText).names.push(nameText);
      }

      // 拒否列が未記入でも、行内に黒塗りセルがあれば訪問拒否として扱う
      const stateIdx = CONFIG.STATE_COLUMN_INDEX; // row配列上の位置（areaName分1つ後ろにずれる）
      if (String(row[stateIdx]).trim() === '' && backgrounds[r].some(isBlackish_)) {
        row[stateIdx] = CONFIG.BLACKOUT_MARK;
        blackoutFilled++;
      }

      // I列・J列: マンション名のリンクからgidを取り出し、シートへの完全URLを生成
      const srcUrl = extractUrl_(
        richText[r][CONFIG.LINK_SOURCE_COLUMN - 1],
        formulas[r][CONFIG.LINK_SOURCE_COLUMN - 1]
      );
      const gid = srcUrl ? extractGid_(srcUrl) : null;
      if (gid !== null) {
        const sheetUrl = fileUrlBase + '?gid=' + gid + '#gid=' + gid;
        row.push('=HYPERLINK("' + sheetUrl + '","' + CONFIG.LINK_TEXT + '")'); // I列
        row.push(sheetUrl);                                                    // J列（裸のURL）
      } else {
        row.push('');
        row.push('');
        noGid++;
      }

      merged.push(row);
    }

    if (noGid > 0) {
      warnings.push('リンクなし ' + noGid + '件: ' + file.getName());
    }
    if (blackoutFilled > 0) {
      warnings.push('黒塗りを拒否として反映 ' + blackoutFilled + '件: ' + file.getName());
    }
  });

  // 出力
  const master = SpreadsheetApp.getActiveSpreadsheet();
  let out = master.getSheetByName(CONFIG.OUTPUT_SHEET_NAME);
  if (!out) out = master.insertSheet(CONFIG.OUTPUT_SHEET_NAME);
  out.clearContents();

  const firstSheet = SpreadsheetApp.openById(files[0].getId())
    .getSheetByName(CONFIG.SOURCE_SHEET_NAME);
  const header = firstSheet
    ? firstSheet.getRange(CONFIG.HEADER_ROW, CONFIG.FIRST_COLUMN, 1, numCols).getDisplayValues()[0]
    : Array(numCols).fill('');
  out.getRange(1, 1, 1, totalCols)
     .setValues([['エリア'].concat(header, [CONFIG.LINK_COLUMN_HEADER, CONFIG.URL_COLUMN_HEADER])]);

  if (merged.length > 0) {
    // J列のURLが自動でリンク化されないよう、書式を「書式なしテキスト」にしてから書き込み
    out.getRange(2, totalCols, merged.length, 1).setNumberFormat('@');
    out.getRange(2, 1, merged.length, totalCols).setValues(merged);
  }

  const cacheAdded = syncCoordCache_(master, addrInfo);
  if (cacheAdded.length > 0) {
    warnings.push('座標キャッシュに新規住所を追加: ' + cacheAdded.length + '件');
    cacheAdded.forEach(item => {
      const statusLabel = item.status === 'OK' ? 'ジオコーディング成功' : 'ジオコーディング失敗・要手動入力';
      warnings.push('　・' + item.area + ' / ' + item.names.join('、') + ' / ' + item.addr + '（' + statusLabel + '）');
    });
  }

  const summaryLine = '統合完了: ' + merged.length + ' 行';
  logUpdateHistory_(master, summaryLine, warnings);

  const msg = summaryLine + '\n' +
    (warnings.length ? '警告:\n' + warnings.join('\n') : '警告なし');
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
}

/**
 * 「更新履歴」シートに実行日時と結果を追記する。
 * シートが無ければ見出し付きで新規作成する。
 * 1回の実行内容は複数行にまたがってよい（サマリー行＋警告ごとの行＋区切りの空行）。
 */
function logUpdateHistory_(master, summaryLine, warnings) {
  let history = master.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  if (!history) {
    history = master.insertSheet(CONFIG.HISTORY_SHEET_NAME);
    history.appendRow(['日時', '内容']);
  }

  history.appendRow([new Date(), summaryLine]);
  warnings.forEach(w => history.appendRow(['', '・' + w]));
  history.appendRow(['', '']); // 実行ごとの区切り
}

/**
 * 統合シートに登場する住所のうち、座標キャッシュにまだ無いものを追記する。
 * 追加時に Maps.newGeocoder() でジオコーディングし、成功すれば緯度・経度・状態(OK)を、
 * 失敗すれば空欄・状態(NG)で追加する（NGの場合は従来通り手動で座標を補う想定）。
 * シートが無ければ見出し付きで新規作成する。
 * 戻り値: 追加した明細の配列 [{area, names, addr, status}, ...]
 */
function syncCoordCache_(master, addrInfo) {
  let cache = master.getSheetByName(CONFIG.CACHE_SHEET_NAME);
  if (!cache) {
    cache = master.insertSheet(CONFIG.CACHE_SHEET_NAME);
    cache.appendRow(['住所', '緯度', '経度', '状態']);
  }

  const existing = new Set();
  const lastRow = cache.getLastRow();
  if (lastRow >= 2) {
    cache.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
      if (r[0]) existing.add(r[0]);
    });
  }

  const added = [];
  const rowsToAdd = [];
  addrInfo.forEach((info, addr) => {
    if (existing.has(addr)) return;
    const geo = geocodeAddress_(addr);
    rowsToAdd.push([addr, geo.lat, geo.lng, geo.status]);
    added.push({ area: info.area, names: info.names, addr: addr, status: geo.status });
  });

  if (rowsToAdd.length > 0) {
    cache.getRange(cache.getLastRow() + 1, 1, rowsToAdd.length, 4).setValues(rowsToAdd);
  }

  return added;
}

/**
 * Apps Script 組み込みの Maps サービスで住所から緯度・経度を取得する。
 * 失敗時（該当なし・通信エラーなど）は状態 NG（緯度・経度は空欄）を返す。
 */
function geocodeAddress_(address) {
  try {
    const res = Maps.newGeocoder().setRegion('jp').geocode(address);
    if (res && res.status === 'OK' && res.results && res.results.length > 0) {
      const loc = res.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, status: 'OK' };
    }
  } catch (e) {
    // 通信エラー等はNG扱いにしてフォールスルー
  }
  return { lat: '', lng: '', status: 'NG' };
}

/**
 * 背景色が黒、またはそれに近い暗色かどうかを判定する（訪問拒否の黒塗り検知用）。
 * 白や色なし（#ffffff）は対象外。
 */
function isBlackish_(hex) {
  const m = String(hex).match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r + g + b) / 3 < 60;
}

/**
 * URLから gid 番号を取り出す。
 * "#gid=521655960" / ".../edit?gid=123#gid=123" のどちらにも対応。
 */
function extractGid_(url) {
  const m = String(url).match(/[#?&]gid=(\d+)/);
  return m ? m[1] : null;
}

/**
 * 内部リンク（#gid=… で始まる）を元ファイルの完全URLに変換する。
 * すでに完全URLならそのまま返す。
 */
function toFullUrl_(url, fileUrlBase) {
  if (String(url).charAt(0) === '#') {
    const gid = extractGid_(url);
    if (gid !== null) return fileUrlBase + '?gid=' + gid + '#gid=' + gid;
    return fileUrlBase + url;
  }
  return url;
}

/**
 * セルからリンクURLを取り出す（埋め込みリンク → HYPERLINK関数の順）。
 */
function extractUrl_(rich, formula) {
  if (rich) {
    const whole = rich.getLinkUrl();
    if (whole) return whole;
    const runs = rich.getRuns();
    for (let i = 0; i < runs.length; i++) {
      const u = runs[i].getLinkUrl();
      if (u) return u;
    }
  }
  if (formula) {
    const m = formula.match(/^=HYPERLINK\(\s*"([^"]+)"/i);
    if (m) return m[1];
  }
  return null;
}

/** ファイル名の先頭の数字を取得（並べ替え・重複判定用） */
function leadingNumber_(name) {
  const m = name.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * （任意）毎朝6時台に自動更新したい場合、この関数を1回だけ実行してください。
 */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'mergeAreaSheets') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('mergeAreaSheets').timeBased().everyDays(1).atHour(6).create();
}

// 自動デプロイテスト用コメント

function runMasterUpdate() {
  try {
    mergeAreaSheets();
    return { ok: true, message: 'マスターデータの更新が完了しました。' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * ご利用スタートガイドのHTMLファイルを、マスタースプレッドシートと同じGoogleドライブのフォルダに作成します。
 * 実行すると、実行ログに共有URLが出力されます。
 */
function createManualInDrive() {
  try {
    // HTMLオブジェクトを作成し、PDFのBlobに変換
    const htmlOutput = HtmlService.createHtmlOutputFromFile('map_app-guide');
    const pdfBlob = htmlOutput.getAs(MimeType.PDF);
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      Logger.log('エラー: このスクリプトはスプレッドシートにバインドされていません。');
      return;
    }
    const file = DriveApp.getFileById(ss.getId());
    const parents = file.getParents();
    const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    
    const fileName = 'ご利用スタートガイド.pdf';
    
    // 同名の古いファイルをゴミ箱へ移動
    const existingFiles = folder.getFilesByName(fileName);
    while (existingFiles.hasNext()) {
      existingFiles.next().setTrashed(true);
    }
    
    // PDFファイルとして作成
    const newFile = folder.createFile(pdfBlob).setName(fileName);
    newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    Logger.log('PDFファイルを作成しました！');
    Logger.log('フォルダ: ' + folder.getName());
    Logger.log('共有URL: ' + newFile.getUrl());
  } catch (e) {
    Logger.log('作成に失敗しました: ' + e);
  }
}
