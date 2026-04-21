# kozotai-slack

Slack のメッセージ・ファイルを受け取り、KOZOTAI 会計に自動転送する Cloudflare Worker です。

指定した Slack チャンネルに投稿されたメッセージやレシート・請求書などの画像・PDFを送信すると、KOZOTAI 会計に自動で取り込まれます。

---

## 事前準備

### 1. Slack App を作成してトークンを取得する

1. [Slack API](https://api.slack.com/apps) を開き、**Create New App** → **From scratch** を選択する
2. App 名と対象ワークスペースを選択して作成する
3. **OAuth & Permissions** を開き、以下の Bot Token Scopes を追加する

  | Scope              | 用途                                         |
  | ------------------ | ------------------------------------------ |
  | `channels:history` | パブリックチャンネルのメッセージイベント受信（Events API の配信に必須）  |
  | `groups:history`   | プライベートチャンネルのメッセージイベント受信（Events API の配信に必須） |
  | `files:read`       | 投稿ファイルのダウンロード                              |
  | `reactions:write`  | 処理中・完了・エラーのリアクション付与・削除                     |

4. **Install App to Workspace** を押してインストールする
5. 以下の値をメモしておく
  - **Basic Information** → Signing Secret
  - **OAuth & Permissions** → Bot User OAuth Token（`xoxb-...`）

### 2. KOZOTAI API キーを取得する

KOZOTAI 管理画面の API 設定から取得してください。

---

## デプロイ

### 3. 「Deploy to Cloudflare」ボタンを押す

> **Note**: デプロイには [Cloudflare アカウント](https://dash.cloudflare.com/sign-up) が必要です（無料プランで動作します）。

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=REPO_URL)

ボタンを押すと Cloudflare のセットアップ画面が開きます。Cloudflare アカウントへのログインと、このリポジトリのクローン先 GitHub アカウントの認可が求められます。

### 4. シークレットを入力する

セットアップ画面で事前準備でメモした値を入力する。


| 項目                      | 値                                      |
| ----------------------- | -------------------------------------- |
| `SLACK_SIGNING_SECRET`  | Slack App の Signing Secret             |
| `SLACK_BOT_TOKEN`       | Slack Bot User OAuth Token（`xoxb-...`） |
| `KOZOTAI_EVENT_API_KEY` | KOZOTAI Event API の API キー             |


`KOZOTAI_EVENT_API_URL` は変更不要です（`https://api.kozotai.com/v1/event` が自動設定されます）。

### 5. デプロイを完了する

**Deploy** を押してください。完了後、Worker の URL が発行されます。

```
https://kozotai-slack.<あなたのサブドメイン>.workers.dev
```

---

## デプロイ後の設定

### 6. Event Subscriptions を設定する

1. Slack App 管理画面 → **Event Subscriptions** を開く
2. **Enable Events** をオンにする
3. **Request URL** に Worker の URL を入力する
  ```
   https://kozotai-slack.<あなたのサブドメイン>.workers.dev/slack/events
  ```
4. **Subscribe to bot events** に `message.channels`（パブリックチャンネル）または `message.groups`（プライベートチャンネル）を追加する
5. **Save Changes** を押す

### 7. App をチャンネルに追加する

転送したいチャンネルで `/invite @<App名>` を実行してください。

---

## 動作の流れ

```
Slack チャンネル
  └─ メッセージ or ファイル投稿
       └─ Slack Events API
            └─ Worker（署名検証 → ファイル取得）
                 └─ KOZOTAI Event API に転送
                      └─ Slack リアクションで結果通知
                           ⏳ 処理中 → ✅ 成功 or ❌ 失敗
```

---

## ローカル開発

```bash
cp .dev.vars.example .dev.vars
# .dev.vars に各シークレットを記入
pnpm install
pnpm dev
```

---

## エンドポイント


| Method | Path            | 説明                  |
| ------ | --------------- | ------------------- |
| `POST` | `/slack/events` | Slack Events API 受信 |
| `GET`  | `/health`       | ヘルスチェック             |


