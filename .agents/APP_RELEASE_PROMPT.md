# アプリ発行プロンプト

この文書は、区域訪問記録マップを発行するAIへの実行指示です。
ユーザーから「デプロイしてください」「アプリを発行してください」「本番へ反映してください」などの依頼を受けた場合は、Google Apps Scriptだけで終わらせず、以下の全工程を完了してください。

## 完了条件

アプリ発行は、次のすべてが完了した状態を指します。

1. アプリのバージョン番号をカウントアップする。
2. アプリ内の更新履歴へ変更内容を追加する。
3. 構文と差分を検証する。
4. バージョン番号で始まるコミットを作成し、GitHubへpushする。
5. 同じソースを本番Google Apps Scriptへpushする。
6. 既存の本番Webアプリのデプロイを新バージョンへ更新する。
7. GitHubとGoogle Apps Scriptの反映結果を確認して報告する。

一部だけを実行して「デプロイ完了」と報告してはいけません。

## 1. 作業前の確認

- `git status -sb`、`git branch --show-current`、`git diff` で現在の状態を確認する。
- ユーザーの未コミット変更や無関係な変更を、勝手に修正、削除、ステージ、コミットしない。
- `git fetch origin` を実行し、ローカルブランチとリモートブランチの進み・遅れを確認する。
- 本番発行は原則として `main` から行う。別ブランチにいる場合は、勝手にmainへマージせずユーザーへ確認する。
- `.clasp.json` の `scriptId` が `.clasp.prod.json` と一致することを確認する。`.clasp.dev.json` の開発環境へ誤配信しない。

## 2. バージョン番号

- 現在のバージョンは `webapp.gs` の `WEBAPP.VERSION` で確認する。
- 特別な指定がなければ、修正リリースとしてパッチ番号を1つ上げる。
  - 例: `v1.11.0` → `v1.11.1`
- 機能追加でマイナー番号、互換性のない大変更でメジャー番号を上げる場合は、ユーザーの指示または明確な合意を得る。
- 開発用の4桁目を使っているブランチでは、その番号を1つ上げる。
  - 例: `v1.11.1.001` → `v1.11.1.002`
- `buildHtml_()` 内の「最近の更新内容」の先頭へ、同じバージョン番号と変更概要を追加する。
- 画面に表示されるバージョンとコミットのバージョンを必ず一致させる。

## 3. 検証

少なくとも次を実行する。

```powershell
Get-Content -Raw -Encoding utf8 webapp.gs | node --check -
git diff --check
git diff --stat
git diff
```

- プロジェクト固有のテストが追加されている場合は、それも実行する。
- 検証に失敗した状態ではGitHubへのpushや本番デプロイを行わない。

## 4. GitHubへの反映

- 意図したファイルだけを明示的にステージする。原則として `git add -A` は使用しない。
- コミットメッセージの先頭には、角括弧付きのバージョン番号を必ず入れる。

```text
[vX.Y.Z] 変更内容の短い説明
```

例:

```text
[v1.11.1] 保護シートのアプリ閲覧・保存を拒否
```

- コミット後、対象ブランチをGitHubの `origin` へpushする。
- push後に `git status -sb` と `git log -1 --oneline` を確認する。
- ユーザーが明示的に求めていない限り、タグ作成、PR作成、リリースページ作成は行わない。

## 5. Google Apps Scriptへの反映

この環境では `clasp` がPATHにない場合がある。その場合は次の形式を使用する。

```powershell
& 'C:\Program Files\nodejs\npx.cmd' --yes @google/clasp status
& 'C:\Program Files\nodejs\npx.cmd' --yes @google/clasp push
```

- `clasp status` で送信対象を確認してから `clasp push` を実行する。
- 本番WebアプリのURLを維持するため、新しいデプロイを増やさず既存の本番デプロイIDを更新する。
- 現在の本番デプロイIDは次のとおり。

```text
AKfycbxQKsGq8yR5BYEP9g7F3xgpXJHd--UwZOCQ6gPtYKUBuDoq-DLB27_-b_EAA9TWAZm_hA
```

- デプロイ説明もバージョン番号から始める。

```powershell
& 'C:\Program Files\nodejs\npx.cmd' --yes @google/clasp deploy `
  --deploymentId 'AKfycbxQKsGq8yR5BYEP9g7F3xgpXJHd--UwZOCQ6gPtYKUBuDoq-DLB27_-b_EAA9TWAZm_hA' `
  --description '[vX.Y.Z] 変更内容の短い説明'
```

- `clasp deployments` を再実行し、同じデプロイIDが新しいApps Scriptバージョンを指していることを確認する。

## 6. 完了報告

最終報告には、少なくとも次を含める。

- 発行したアプリのバージョン番号
- GitHubのブランチ名
- Gitコミットの短縮SHAとコミットメッセージ
- GitHubへのpush結果
- Google Apps Scriptのデプロイバージョン番号
- 既存WebアプリURLを維持したこと
- 実行した検証とその結果
- 未コミット変更の有無

## 安全上の禁止事項

- ユーザーの無関係な変更を破棄しない。
- `git reset --hard` や強制pushを行わない。
- 本番デプロイIDを確認せず、新規デプロイを作らない。
- GitHubだけ、またはGoogle Apps Scriptだけを更新して完了扱いにしない。
- 認証や権限のエラーを回避しようとして、別アカウントや別プロジェクトへ配信しない。
- 手順の途中で失敗した場合は、完了した範囲と未完了の範囲を明確に報告する。
