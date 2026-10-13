# LINE

[OpenClawの標準LINEガイド](https://docs.openclaw.ai/channels/line)と同じ設定名・アクセス制御で、LINE Botを接続します。このブリッジではLINE機能を本体に同梱しています。

## Install

このリポジトリでインストールします。Node.js 22.13以降が必要です。

```bash
npm install
```

初回だけ設定ファイルを作ります。すでに `bridge.config.json` と `.env` がある場合は、その設定を使います。

```bash
./bin/codex-line-bridge init
```

以下のコマンドはローカルチェックアウトの `./bin/codex-line-bridge` を使います。

## Setup

1. LINE Business IDを登録し、LINE公式アカウントを作成します。[LINE Official Account Manager](https://manager.line.biz/)で対象アカウントを開きます。
2. Official Account Managerの **設定 → Messaging API** でMessaging APIを有効にします。これによりMessaging APIチャネルが作成されます。
3. 管理する **Provider** を作成または選択します。**選択後はProviderを変更・解除できません。** [LINE公式の作成手順](https://developers.line.biz/en/docs/messaging-api/getting-started/)も参照してください。
4. 同じBusiness IDで[LINE Developers Console](https://developers.line.biz/console/)を開き、選んだProvider内のMessaging APIチャネルを開きます。**Basic settings** から **Channel secret**、**Messaging API** タブから **Channel access token** を取得します。
5. **Webhook URL** に、Gatewayの公開HTTPS endpointを設定します。以下のConfigureでGatewayを起動した後に **Verify** の成功を確認し、**Use webhook** を有効にします。
6. Official Account Managerの応答設定で **応答メッセージ** と **あいさつメッセージ** を無効にすると、Botからの返信を確認しやすくなります。どちらもチャネル作成時は有効です。[LINE公式のBot設定](https://developers.line.biz/en/docs/messaging-api/building-bot/)に詳細があります。

```text
https://gateway-host/line/webhook
```

`.env` の `LINE_BRIDGE_PUBLIC_URL` に同じ公開ホストを設定します。この値には `/line/webhook` を付けません。

```dotenv
LINE_BRIDGE_PUBLIC_URL=https://gateway-host
```

パスを変える場合は `channels.line.webhookPath` または `channels.line.accounts.<id>.webhookPath` を変更し、LINE側のWebhook URLも合わせます。Gatewayを動かすホストはオンラインにしておきます。

## Configure

ターミナルの案内に従って設定します。トークンとシークレットの入力内容は表示されません。

```bash
./bin/codex-line-bridge channels add --channel line
```

`.env` を手元で編集する方法も使えます。環境変数はdefault account用です。

```dotenv
LINE_CHANNEL_ACCESS_TOKEN=取得したChannelアクセスToken
LINE_CHANNEL_SECRET=取得したChannelSecret
```

`bridge.config.json` の最小LINE設定です。

```json
{
  "channels": {
    "line": {
      "enabled": true,
      "channelAccessToken": "${LINE_CHANNEL_ACCESS_TOKEN}",
      "channelSecret": "${LINE_CHANNEL_SECRET}",
      "dmPolicy": "pairing"
    }
  }
}
```

ファイルで渡す場合は同じ場所に `tokenFile` と `secretFile` を指定します。通常ファイルを使い、シンボリックリンクは使いません。優先順位は直接設定した値、ファイル、default accountの環境変数です。

```json
{
  "channels": {
    "line": {
      "tokenFile": "/path/to/line-token.txt",
      "secretFile": "/path/to/line-secret.txt",
      "dmPolicy": "pairing"
    }
  }
}
```

複数accountは、それぞれに認証情報とWebhookパスを設定します。

```json
{
  "channels": {
    "line": {
      "accounts": {
        "marketing": {
          "tokenFile": "/path/to/marketing-token.txt",
          "secretFile": "/path/to/marketing-secret.txt",
          "webhookPath": "/line/marketing"
        }
      }
    }
  }
}
```

Gatewayを起動します。

```bash
./bin/codex-line-bridge gateway
```

## Access control

DMは `pairing` が標準です。初めての送信者にはペアリングコードが届き、管理者の承認後にもう一度送ったメッセージから受け付けます。

```bash
./bin/codex-line-bridge pairing list line
./bin/codex-line-bridge pairing approve line <CODE>
```

| 設定 | 値・動作 |
| --- | --- |
| `channels.line.dmPolicy` | `pairing` / `allowlist` / `open` / `disabled`。標準は `pairing` |
| `channels.line.allowFrom` | DMを許可するLINE user ID。`open` では `["*"]` が必要 |
| `channels.line.groupPolicy` | `allowlist` / `open` / `disabled`。標準は `allowlist` |
| `channels.line.groupAllowFrom` | グループを許可するLINE user ID。DMの許可とは独立 |
| `channels.line.groups.<groupId>.allowFrom` | そのグループ・roomの送信者を個別に許可 |
| `channels.line.groups.<groupId>.enabled` | そのグループ・roomを有効化・無効化 |
| `channels.line.groups.<groupId>.requireMention` | メンションがあるメッセージを受け付ける |

`groupPolicy: "allowlist"` では、`groupAllowFrom` または個別の `allowFrom` を設定します。グループ側が空なら、DMを `open` にしてもグループのメッセージは受け付けません。

`groups."*"` は各グループ・roomの共通設定です。個別設定は指定した項目だけを上書きします。Botの発言を引用した返信も呼び出しとして扱います。この動作を止める場合は、共通設定の `channels.defaults.implicitMentions.quotedBot` を `false` にします。

LINE IDは大文字・小文字を区別します。userは `U`、groupは `C`、roomは `R` に、それぞれ32桁の16進文字が続きます。

## Troubleshooting

- **WebhookのVerifyが失敗する:** URLがHTTPSで、`channelSecret` がLINE Consoleの値と一致しているか確認します。
- **受信できない:** `./bin/codex-line-bridge channels status --probe` を実行します。表示されるWebhookの `endpoint` と `active` を確認し、Consoleの **Use webhook** と登録URLを合わせます。`--probe` を付けない場合はLINE側の状態を取得しません。
- **承認前のDMに返答しない:** `pairing list line` でコードを確認し、`pairing approve line <CODE>` で承認後、LINEからもう一度送ります。
- **グループだけ反応しない:** グループ用の送信者許可と `requireMention` を確認し、Botをメンションして送ります。
- **添付を取得できない:** `channels.line.mediaMaxMb` の上限を確認します。標準は10MBです。
- **HTTP 429でPushが拒否される:** LINE Official Account Managerで送信枠とプランを確認します。接続診断が成功しても送信枠が残っているとは限りません。

永続保存に失敗したWebhookの再送を受けるには、Consoleの **Webhook redelivery** も有効にします。再送には重複や順序の入れ替わりがあり得ます。

LINE接続ができたら、[Your dotへの接続](dot-integration.md)へ進みます。Your dotとの連携はMCP Eventsによる購読で、LINEを純正のcontact methodとして登録する機能ではありません。
