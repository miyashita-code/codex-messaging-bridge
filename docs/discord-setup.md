# Discord

[OpenClawのDiscordセットアップ](https://docs.openclaw.ai/channels/discord/setup)に合わせた手順で、Discord Botを接続します。設定は `channels.discord`、DMの初回承認は `pairing`、メッセージ受信はDiscord Gatewayです。

Discord側との通信は外向きのWebSocketとHTTPSだけなので、Discordのための公開ドメイン、Webhook URL、HTTPSサーバーは不要です。Gateway接続を保つプロセスと保存領域は必要です。[Discord Gateway仕様](https://docs.discord.com/developers/events/gateway)

## Install

Node.js 22.13以降で、このリポジトリを使います。

```bash
npm install
```

設定ファイルがまだない場合だけ作成します。

```bash
./bin/codex-line-bridge init
```

公開HTTPサーバーを使わず、Discordと同じコンピューターの受信箱だけを使う場合は、同梱の `bridge.discord.cloud.example.json` を設定ファイルとして指定します。

```bash
./bin/codex-line-bridge --config bridge.discord.cloud.example.json channels add --channel discord
```

LINEとDiscordは同時に使えます。Discordだけを使う場合は `channels.line.enabled` を `false` にします。

## Quick setup

### 1. Discord applicationとBotを作る

[Discord Developer Portal](https://discord.com/developers/applications)で新しいApplicationを作ります。Botの画面でAI秘書の名前とアイコンを設定します。個人用なら、Botを招待する専用のサーバーを用意すると会話を整理しやすくなります。

### 2. Privileged Gateway Intentsを設定する

Botの画面で **Message Content Intent** を有効にします。サーバー内でメンションのない普通のメッセージを読むために必要です。**Server Members Intent** はメンバー情報を利用するときに有効にし、設定の `intents.guildMembers` も `true` にします。Presence情報はこのブリッジの受信処理では使用しません。[DiscordのIntents仕様](https://docs.discord.com/developers/events/gateway#gateway-intents)

### 3. Bot tokenを取得する

Botの画面からTokenを発行します。Tokenは手元の設定用に保持し、チャットには貼り付けません。

### 4. 招待URLでサーバーへ追加する

OAuth2のURL Generatorで `bot` と `applications.commands` のscopesを選びます。Bot Permissionsではチャンネル閲覧、メッセージ送信、履歴閲覧を許可します。リンクの埋め込みやファイルの添付を使う場合は、それぞれの権限も選びます。スレッド内で返信する場合は **Send Messages in Threads** も必要です。生成したURLを開き、接続したいサーバーへBotを追加します。管理者権限は通常不要です。[DiscordのPermissions仕様](https://docs.discord.com/developers/topics/permissions)

### 5. Developer ModeでIDを取得する

Discordのユーザー設定から開発者モードを有効にします。サーバーと自分のプロフィールのメニューからIDをコピーします。チャンネルを絞る場合は、そのチャンネルのIDもコピーします。設定ファイルではIDを文字列として記入します。

### 6. BotとのDMを許可する

サーバーのプライバシー設定でサーバーメンバーからのDMを許可し、BotのプロフィールからDMを開きます。初回ペアリングにも使います。

### 7. Tokenを設定する

ターミナルの案内に従って設定します。Tokenの入力内容は表示されません。

```bash
./bin/codex-line-bridge channels add --channel discord
```

手元で `.env` を編集する方法も使えます。

```dotenv
DISCORD_BOT_TOKEN=取得したBotToken
```

最小のDiscord設定です。これはLINEを含めた既存設定に追加するブロックです。

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "${DISCORD_BOT_TOKEN}",
      "dmPolicy": "pairing"
    }
  }
}
```

OpenClawと同じ環境変数のSecretRef表記も利用できます。このブリッジでは `source: "env"` と `provider: "default"` をサポートします。

```json
{
  "token": {
    "source": "env",
    "provider": "default",
    "id": "DISCORD_BOT_TOKEN"
  }
}
```

ファイルに保存したTokenは `tokenFile: "/path/to/discord-token.txt"` でも指定できます。通常ファイルを使用し、シンボリックリンクは受け付けません。優先順位は直接設定、ファイル、default accountの `DISCORD_BOT_TOKEN` です。名前付きaccountは自分のTokenを指定します。

### 8. Gatewayを起動する

```bash
./bin/codex-line-bridge gateway
```

Your dotが同じコンピューター上の受信箱を読む方式は、設定の `backend: "inbox"` を使います。この方式では公開MCP endpointも不要です。受信と返信の流れは[Your dot接続ガイド](dot-integration.md)を参照してください。クラウドコンピューターに置いただけでプロセスが24時間継続するとは確認できていないため、稼働時間と再起動後の状態をその環境で確認してください。

同梱の受信箱用設定には `backend: "inbox"` と `transport: "headless"` が指定されています。この場合の起動コマンドです。

```bash
./bin/codex-line-bridge --config bridge.discord.cloud.example.json gateway
```

### 9. 初回DMのペアリングを承認する

BotへDMを送ると、未承認の送信者にはペアリングコードが届きます。管理者側で承認し、Discordからもう一度送ります。

```bash
./bin/codex-line-bridge pairing list discord
./bin/codex-line-bridge pairing approve discord <CODE>
```

設定ファイルを指定して起動した場合は、ペアリング操作にも同じ `--config bridge.discord.cloud.example.json` を付けます。

## Hostingを使わない受信と返信

Gatewayを起動したコンピューターで受信箱を取得し、返信します。Your dotのクラウドコンピューターで実行する場合も、同じ設定ファイルと保存領域を使います。

```bash
./bin/codex-line-bridge --config bridge.discord.cloud.example.json inbox list --channel discord
./bin/codex-line-bridge --config bridge.discord.cloud.example.json inbox read <MESSAGE_ID>
./bin/codex-line-bridge --config bridge.discord.cloud.example.json inbox reply <MESSAGE_ID> --text "返信内容" --idempotency-key <REPLY_KEY>
```

`REPLY_KEY` はその返信専用の安定したキーです。同じ返信を再試行する場合は同じキーを使います。別の返信には新しいキーを使います。メッセージIDに紐付いた会話へ送るため、返信時に別のチャンネルIDを指定する必要はありません。

この方式ではYour dotが起きて受信箱を確認するときに処理します。常駐プロセスの維持や、受信を契機にYour dotを起こす機能がそのクラウドコンピューターで提供されるかは別途確認が必要です。

## Guild workspace

サーバーでも使う場合は、Server IDを `guilds` に追加します。サーバー内の会話は、DMのペアリング承認とは独立して許可します。[OpenClawのアクセス制御](https://docs.openclaw.ai/channels/discord/access-control)

```json
{
  "channels": {
    "discord": {
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_SERVER_ID": {
          "requireMention": true,
          "users": ["YOUR_USER_ID"]
        }
      }
    }
  }
}
```

Botをメンションしたメッセージ、またはBotの発言に返信したメッセージを受け付けます。サーバーで常に応答させたい場合は、そのサーバーの `requireMention` を `false` にします。チャンネルごと、スレッドごとに別の会話として保持します。

チャンネルを限定する設定です。`channels` を1つでも追加すると、そのマップは許可リストになります。設定していないチャンネルは受け付けません。ほかのチャンネルも許可する場合は `"*"` を追加します。スレッドは親チャンネルの設定を継承し、スレッドIDの個別設定がある場合はそちらを優先します。

```json
{
  "guilds": {
    "YOUR_SERVER_ID": {
      "users": ["YOUR_USER_ID"],
      "requireMention": true,
      "channels": {
        "YOUR_CHANNEL_ID": {
          "enabled": true,
          "requireMention": false
        },
        "*": {
          "enabled": true,
          "requireMention": true
        }
      }
    }
  }
}
```

| 設定 | 動作 |
| --- | --- |
| `dmPolicy` | `pairing` / `allowlist` / `open` / `disabled`。標準は `pairing` |
| `allowFrom` | DMの送信者ID。`discord:ID`、`user:ID`、ユーザーメンションも使用可能。`open` では `["*"]` が必要 |
| `dm.enabled` | `false` でDMを停止 |
| `dm.groupEnabled` / `dm.groupChannels` | グループDMは標準で停止。明示的に有効化し、必要ならチャンネルIDで限定。DMの送信者許可も適用 |
| `groupPolicy` | `allowlist` / `open` / `disabled`。標準は `allowlist` |
| `guilds.<serverId>.users` / `.roles` | 送信者IDまたはRole IDに一致するメンバーを許可。どちらかが一致すれば受付 |
| `guilds.<serverId>.channels.<channelId>` | チャンネル別の送信者・メンション設定。サーバー設定の指定項目を上書き |
| `allowBots` | 標準は `true`。`false` でBot発言を停止。`"mentions"` は本文でBotを呼び出した場合だけ受付。自身の発言は常に除外 |
| `mediaMaxMb` | 添付サイズ上限。標準100MB。Discord側の上限・権限も適用 |

複数Botは `channels.discord.accounts.<accountId>` ごとにTokenと設定を追加します。`DISCORD_BOT_TOKEN` はdefault accountにだけ適用され、名前付きaccountは別Tokenを指定します。設定を変更した後はGatewayを再起動します。

Bot同士の連続応答には、account・チャンネル・相手Botごとの短時間制限を適用します。標準は60秒に20件、上限到達後は60秒停止です。`allowBots: false` ならBotからの呼び出し自体を停止できます。[OpenClawのBotループ対策](https://docs.openclaw.ai/channels/discord/troubleshooting#bot-to-bot-loops)

## Troubleshooting

- **Botがオンラインにならない:** `./bin/codex-line-bridge channels status --probe` でTokenの状態を確認します。Discordへの外向きHTTPS/WebSocket通信を許可し、Gatewayを起動したコンピューターを稼働させます。
- **Intentが拒否される:** Developer Portalと `channels.discord.intents` の設定を合わせます。Message Content Intentを有効にしたあとGatewayを再起動します。
- **DMが受け付けられない:** サーバーのDM設定、`dm.enabled`、`dmPolicy` とペアリングの承認を確認します。
- **サーバーだけ反応しない:** Server ID、送信者の `users` / `roles`、`channels` 許可リスト、Botへのメンションを確認します。
- **スレッドで返信できない:** Botのスレッド送信権限と、親チャンネルが許可されているか確認します。
- **受信は見えるがAIの返答がない:** `inbox` では受信箱の取得と返信を行うYour dotの処理が必要です。`dot` ではMCP Eventsの購読を確認します。

この実装で移植したのはメッセージ接続、DMのペアリング、アクセス設定と会話分離です。OpenClaw本体の音声会話、Discord Activities、Slash commandの全カタログ、管理・モデレーション機能、ACPやサブエージェントのスレッド管理までを実装したものではありません。
