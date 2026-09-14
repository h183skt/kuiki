# 管理用スクリプト（区域データ統合ツール）

区域スプレッドシートを「統合」シートへマージする、**オーナー専用**の管理ツールです。
ウェブアプリ（リポジトリ直下の `webapp.gs`）からは一度も呼ばれません。

## 移行先プロジェクト

<https://script.google.com/d/1KGzqJ4GI75hMXkWuWRFmXMjQYfMErBX0TdOXu4Vnme57S-vtrqGSPXoH/edit>

スクリプトIDは `.clasp.json`（gitignore 済み）に保持しています。
別の環境から push する場合は、このIDで `admin/.clasp.json` を作り直してください。

## なぜ別プロジェクトに分けたのか

Google Apps Script の OAuth スコープは**プロジェクト単位で合算**されます。
このスクリプトは `DriveApp` を使うため、同じプロジェクトに同居していると
ウェブアプリの利用者全員が「ドライブのすべてのファイルの表示・編集・作成・削除」を
要求されていました。`drive` は Google の分類で「制限付きスコープ」にあたり、
初回起動時の警告が最も不穏な形で表示されるうえ、OAuth 審査を通す道も塞がれます。

これを切り離したことで、ウェブアプリ側が求める権限は次の 2 つだけになりました。

- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/userinfo.email`

## 移行手順（初回のみ）

1. **新しいスタンドアロンのプロジェクトを作る**
   <https://script.google.com/home> →「新しいプロジェクト」。
   名前は「区域データ統合ツール（管理用）」など分かりやすいものにする。

2. **スクリプトIDを控える**
   プロジェクトの設定 → スクリプトID をコピーし、`admin/.clasp.json` を作る。

   ```json
   { "scriptId": "ここにスクリプトID", "rootDir": "." }
   ```

   このファイルは `.gitignore` 済みなのでコミットされません。

3. **`CONFIG.MASTER_SHEET_ID` を設定する**
   `コード.gs` の先頭。統合マスターのスプレッドシートのURL
   `https://docs.google.com/spreadsheets/d/★この部分★/edit` を貼り付ける。

4. **push する**

   ```powershell
   cd admin
   & 'C:\Program Files\nodejs\npx.cmd' --yes @google/clasp push
   ```

5. **エディタから `mergeAreaSheets` を 1 回実行して認可する**
   ドライブとスプレッドシートの権限を許可する。

6. **トリガーを貼り直す**
   - `setupMenuTrigger` を 1 回実行 → シートの「区域訪問記録アプリ」メニューが復活する
   - 日次自動更新を使っている場合は `setupDailyTrigger` も 1 回実行する
   - **旧プロジェクト（ウェブアプリ側）に残っている古いトリガーは削除する**

7. **最後にウェブアプリ側を push する**
   リポジトリ直下の `.claspignore` から `コード.gs` と `map_app-guide.html` が
   外れているため、`clasp push --force` で旧プロジェクトからこの 2 ファイルが削除される。
   **手順 6 まで終えてから実行すること。**

## 注意

- `onOpen` はバインドされていないスクリプトでは自動実行されないため、
  `setupMenuTrigger` で作るインストーラブルトリガー経由で動きます。
- `map_app-guide.html` は `createManualInDrive()` が PDF 化に使うため、
  このディレクトリに置いています。
