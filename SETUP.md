# FLH シフト希望システム — セットアップ手順

所要時間: 約30〜40分。上から順に進めてください。

---

## 全体像

```
スタッフのスマホ（ブラウザ）
   │  Googleログイン
   ▼
GitHub Pages（このリポジトリ / 画面）
   │  API呼び出し
   ▼
Google Apps Script（バックエンド）
   ├── Googleスプレッドシート（データ保存）
   ├── 各スタッフのGoogleカレンダー（自動反映）
   ├── 共有カレンダー（管理者用）
   └── Slack Webhook（通知）
```

---

## STEP 1: スプレッドシート作成（3分）

1. https://sheets.new で新しいスプレッドシートを作成
2. 名前を「FLHシフトDB」などに変更
3. URLの `https://docs.google.com/spreadsheets/d/●●●/edit` の `●●●` 部分（スプレッドシートID）をメモ

## STEP 2: Google Apps Script プロジェクト作成（10分)

1. STEP 1 のスプレッドシートを開いた状態で「拡張機能」→「Apps Script」
2. `Code.gs` の中身を全て消し、このリポジトリの `gas/Code.gs` の内容を貼り付け
3. 左メニュー「プロジェクトの設定」→「タイムゾーン」を **東京** に
4. 同じく「プロジェクトの設定」→ 下部「スクリプト プロパティ」で以下を追加:

| プロパティ名 | 値 |
|---|---|
| `SPREADSHEET_ID` | STEP 1 でメモしたID |
| `APP_URL` | `https://hirunegao.github.io/flh-shift/` |
| `DIAG_SECRET` | 任意の長いランダム文字列（診断URL用。未設定なら診断は無効） |

（`OAUTH_CLIENT_ID` などは後のSTEPで追加します）

5. エディタ上部の関数選択で `setup` を選び「実行」→ 権限を承認
   → スプレッドシートに Staff / Locations / Patterns / Shifts / Submissions / ChangeRequests / Settings / AuditLog シートが自動作成されます
6. 関数選択で `setupTriggers` を選び「実行」
   → 毎朝10時のリマインダー ＋ 深夜3時のスプレッドシートバックアップ（Driveフォルダ `FLHシフトDB_backup`・7日分）が登録されます

## STEP 3: GAS をWebアプリとしてデプロイ（5分）

1. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
2. 設定:
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
3. 「デプロイ」→ 表示された **ウェブアプリURL**（`https://script.google.com/macros/s/.../exec`）をメモ

> ⚠️ 以後 `Code.gs` を修正した場合は「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」で更新しないと反映されません。

## STEP 4: Google Cloud で OAuth クライアント作成（10分）

Googleログインとカレンダー書き込みに必要です。

1. https://console.cloud.google.com/ で新しいプロジェクトを作成（例: `flh-shift`）
2. 「APIとサービス」→「ライブラリ」→ **Google Calendar API** を検索して「有効にする」
3. 「APIとサービス」→「OAuth同意画面」:
   - User Type: **外部** → 作成
   - アプリ名: `FLHシフト希望` / サポートメール: 自分のメール
   - スコープ追加: `.../auth/calendar.events`
   - テストユーザー: **スタッフ全員のGmailアドレスを追加**（公開申請しない場合は必須）
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」:
   - アプリケーションの種類: **ウェブアプリケーション**
   - 承認済みのJavaScript生成元: `https://hirunegao.github.io`
   - 承認済みのリダイレクトURI: `https://hirunegao.github.io`
5. 作成された **クライアントID** と **クライアントシークレット** をメモ
6. GASの「スクリプト プロパティ」に追加:

| プロパティ名 | 値 |
|---|---|
| `OAUTH_CLIENT_ID` | クライアントID |
| `OAUTH_CLIENT_SECRET` | クライアントシークレット |

> ⚠️ クライアントシークレットは絶対にフロントのコード（このリポジトリ）に書かないでください。

## STEP 5: フロントの設定を書き換えてプッシュ（3分）

`js/config.js` の2箇所を書き換え:

```js
var GAS_URL = 'STEP 3 のウェブアプリURL';
var GOOGLE_CLIENT_ID = 'STEP 4 のクライアントID';
```

コミットしてプッシュすると GitHub Pages に反映されます（数分）。

## STEP 6: 共有カレンダー作成（3分・任意）

1. Googleカレンダーで「新しいカレンダーを作成」→ 名前「FLHシフト（全体）」
2. カレンダーの設定 →「カレンダーの統合」→ **カレンダーID** をメモ
3. GASの「スクリプト プロパティ」に追加:

| プロパティ名 | 値 |
|---|---|
| `SHARED_CALENDAR_ID` | カレンダーID |

4. 他の管理者に見せる場合は「特定のユーザーとの共有」で管理者を追加

## STEP 7: Slack Webhook 作成（5分・任意）

1. https://api.slack.com/apps →「Create New App」→「From scratch」
2. アプリ名「シフト通知」、ワークスペースを選択
3. 「Incoming Webhooks」→ ON →「Add New Webhook to Workspace」→ 通知先チャンネル（例: `#シフト`）を選択
4. 発行された Webhook URL を GASの「スクリプト プロパティ」に追加:

| プロパティ名 | 値 |
|---|---|
| `SLACK_WEBHOOK_URL` | Webhook URL |

## STEP 8: 初期データ登録（5分）

スプレッドシートの **Staff** シートに、まず自分（管理者）を1行登録:

| email | name | isAdmin | locationIds | active |
|---|---|---|---|---|
| あなたのGmail | あなたの名前 | true | | true |

その後、アプリ（https://hirunegao.github.io/flh-shift/）にGoogleログインし、
**管理タブ → マスタ** から画面上で以下を登録できます:

1. 拠点（店舗）
2. シフトパターン（早番 09:00〜17:00 など）
3. スタッフ全員（メール・名前・所属拠点・管理者フラグ）

## STEP 9: 動作確認チェックリスト

- [ ] スタッフのGmailでログインできる（未登録メールは弾かれる）
- [ ] シフト希望を入力→「完了して提出」でロックされる
- [ ] 提出時に本人のGoogleカレンダーに「【未確定】出勤」が入る
- [ ] Slackに提出通知が届く / 管理者にメールが届く
- [ ] 管理者が承認→カレンダーのタイトルが「出勤」になり、共有カレンダーにも入る
- [ ] ロック後に「変更リクエスト」→管理者が承認→再編集できる
- [ ] グリッド表で日毎人数が見える / CSVがダウンロードできる

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| ログイン後「このアカウントは登録されていません」 | StaffシートにそのGmailが未登録。管理者がマスタ画面かシートで追加 |
| 「認証に失敗しました」 | config.js のクライアントIDとGAS側 `OAUTH_CLIENT_ID` が不一致。両方確認 |
| カレンダー連携のポップアップでエラー | OAuth同意画面のテストユーザーに本人のGmailが未登録 |
| 通信エラーが出る | GASのデプロイ設定が「全員」になっているか確認。Code.gs更新後は「新バージョン」で再デプロイ |
| Slack通知が来ない | `SLACK_WEBHOOK_URL` の設定漏れ。AuditLogシートに slack_error が無いか確認 |
| リマインドが来ない | `setupTriggers` を実行したか確認（GASの「トリガー」メニューに dailyReminder があるか） |
| 診断URLが forbidden | `DIAG_SECRET` を設定し、`?diag=1&key=その値` でアクセスする（未設定時は診断無効） |
| バックアップが無い | `setupTriggers` 再実行。Driveに `FLHシフトDB_backup` フォルダができるか確認 |
