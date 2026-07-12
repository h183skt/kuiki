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

  OUTPUT_SHEET_NAME: '統合', // 出力先シート名（毎回全消去して書き直します）
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

  files.forEach(file => {
    const areaName = file.getName().replace(/\s*のコピー\s*$/, '').trim();
    const areaKey = leadingNumber_(file.getName());

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

    let noGid = 0;

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

  const msg = '統合完了: ' + merged.length + ' 行\n' +
    (warnings.length ? '警告:\n' + warnings.join('\n') : '警告なし');
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
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
