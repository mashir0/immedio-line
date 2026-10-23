# Googleカレンダー → LINE通知

Googleカレンダーで、タイトルが指定の接頭辞で始まる予定が新規追加されたときに、LINEへ通知するためのGoogle Apps Script（GAS）です。

> 現時点では導入用READMEです。通知処理・設定キー・トリガー登録関数・配布パッケージ作成コマンドは未実装／未確定です。以下の導入準備だけでは通知は開始されません。

## 配布・運用方針

- 社員ごとに独立したGASプロジェクトを作成し、自分のGoogleアカウントで実行します。
- コードは共通ですが、カレンダー・通知先・認証情報・実行トリガーは各自で設定します。
- 社内共通のカレンダーを共通のLINEへ通知する場合は、各自に導入せず、1つのGASで集中運用する方法もあります。
- 実行環境はGoogle側です。設定後に手元のPCを起動し続ける必要はありません。

## 必要なもの

- 対象カレンダーを閲覧できるGoogleアカウント
- miseで管理するNode.js・npm
- clasp（`@google/clasp`）
- LINE Messaging APIの利用環境と通知先

LINE Notifyは使用しません。LINE公式アカウント／Messaging APIチャネルの準備、通知先IDの取得、送信条件・料金プランの確認が別途必要です。

## 導入準備

### 1. ファイルを展開する

配布ZIPを任意のフォルダに展開し、そのフォルダでターミナルを開きます。

想定する配布構成：

```text
README.md
mise.toml
src/
  main.js
  appsscript.json
```

この構成は配布時の想定です。通知コードやZIPの作成処理は別途用意します。

### 2. 開発環境をインストールする

miseがインストールされ、シェルで有効になっていることを前提とします。

```bash
mise install
node -v
npm -v
npm install -g @google/clasp
clasp --version
```

Node.js・npmは同梱の`mise.toml`に記載されたバージョンを使用します。現時点ではclaspのバージョンは固定していません。

### 3. Googleにログインする

```bash
clasp login
```

ブラウザで、対象カレンダーを利用するGoogleアカウントにログインします。

続いて、以下のページで「Google Apps Script API」を有効にします。

https://script.google.com/home/usersettings

会社のGoogle Workspaceの管理設定によっては、管理者の承認が必要です。

### 4. 自分用のGASプロジェクトを作成する

```bash
clasp create --title "Calendar LINE通知" --type standalone --rootDir src
```

Google Drive上に独立したGASを作成し、ローカルに接続先の`.clasp.json`を生成します。

`clasp create`は`src/appsscript.json`を生成・更新する場合があります。配布されたマニフェストに必要な設定がある場合は、差分を確認してから反映してください。

**配布元の`.clasp.json`は使い回さないでください。** 各自が作ったGASのIDを使用します。

## アプリの設定・利用開始（実装後）

次の内容は、通知処理の実装に合わせて具体的な設定キー・関数名を追記します。

1. 対象カレンダーのIDを設定する。
2. 通知対象となる予定タイトルの接頭辞を設定する。
3. LINEのチャネルアクセストークンと通知先IDを設定する。
4. `clasp push`でコードをGASに反映する。
5. GASエディタで初期設定関数を実行し、必要な権限を承認する。
6. 初期同期を実施し、既存予定を通知しないための基準を保存する。
7. 実行トリガーを登録し、テスト予定を追加して通知を確認する。

LINEのアクセストークンなどの秘密情報は、GASの「プロジェクトの設定 → スクリプト プロパティ」に保存する方針です。コードや配布ZIPには含めません。

スクリプトプロパティは、そのGASの編集者が参照できます。GASの編集権限を与える相手も限定してください。

### 反映と公開デプロイの違い

- `clasp push`：GAS上のソースコードを更新します。
- 公開デプロイ：Webアプリなどとして公開するときに使います。

今回のようなトリガー実行だけの処理では、通常、Webアプリとしての公開デプロイは不要です。初回承認とトリガー登録は別途必要です。

## 通知仕様で確認すること

- カレンダートリガーは予定の追加だけでなく、変更・削除でも発火するため、新規予定の判別が必要です。
- 初回導入時の既存予定をまとめて通知しないようにします。
- 同じ予定の重複通知を防ぎます。
- 繰り返し予定、招待された予定、後から接頭辞が付いた予定の扱いは未確定です。
- 即時通知や配信成功を保証するものではありません。Google／LINEの制限や障害の影響を受けます。
- カレンダーの件名・日時など、LINEへ送信する項目を実装時に決めます。社内情報を外部サービスに送るため、会社の利用ルールを確認してください。

## 開発時のファイル管理

### Git管理するもの

- ソースコード
- `appsscript.json`
- `mise.toml`
- READMEなどの手順書
- パッケージ化の設定・スクリプト（実装後）

### Git管理・配布しないもの

- `.clasp.json`：各利用者のGAS接続先
- `.clasprc.json`：Google認証情報（通常はホームディレクトリに保存）
- LINEトークンなどの秘密情報
- `.env`などのローカル設定
- `node_modules/`
- `.git/`（配布ZIPには含めない）

`.clasp.json`自体は認証情報ではありませんが、配布元のGASへ誤って反映しないよう、この配布方式では除外します。

`.gitignore`の例：

```gitignore
node_modules/
.DS_Store
.env
.env.*
!.env.example
.clasprc.json
.clasp.json
dist/
```

`.gitignore`はGitへの登録を制御するもので、ZIPやGASへのアップロードを自動的に制限するものではありません。配布処理は必要なファイルだけを明示して収集します。GASへのアップロード範囲は`.clasp.json`の`rootDir`と、必要に応じて`.claspignore`で制御します。

## 配布パッケージ（未実装）

`dist/`に配布用ファイルを収集してZIP化する構成を想定しています。`npm run package`などの実行コマンドは、パッケージ作成処理を実装した後に追記します。

アップデート時は、各利用者の`.clasp.json`を保持したままソースコードを置き換え、`clasp push`で反映します。設定変更・再承認・トリガーの更新が必要なリリースでは、別途更新手順を案内します。

## 参考

- clasp：https://github.com/google/clasp
- Apps Script：https://developers.google.com/apps-script/guides/clasp
- LINE Messaging API：https://developers.line.biz/ja/docs/messaging-api/
