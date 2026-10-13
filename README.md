# Codex LINE / Discord Bridge

LINE・Discordから、Your dotまたは自分のCodexをAI秘書として使うためのブリッジです。OpenClawと同じ設定名・Botセットアップの流れ・ペアリング形式に合わせています。MITライセンスで、各自のBotとアカウントを接続して使えます。

An open-source LINE / Discord bridge for Your dot and personal Codex. It follows OpenClaw-style channel settings, setup and pairing. Use your own bot, credentials and data directory. See the [English quickstart](#english-quickstart).

## 使い方を選ぶ

| 構成 | 応答するAI | 公開HTTPS | 動作 |
| --- | --- | --- | --- |
| Discord + 個人用Codex | 同じコンピューターのCodex | 不要 | Gatewayで受信し、自動でCodexが返答 |
| Discord + Your dot受信箱 | 同じcomputerで受信箱を確認するYour dot | 不要 | CLIで読取・返信。新着によるdotの自動起動はなし |
| LINE / Discord + Your dot MCP | Your dot | MCP接続先に必要 | MCP Eventsを購読し、新着からdotが処理 |
| LINE + 個人用Codex | 同じコンピューターのCodex | LINE Webhookに必要 | 署名を検証して受信し、自動でCodexが返答 |

DiscordのGateway受信は外向き接続を使うため、公開ドメインやWebhookサーバーを省けます。Botプロセスを動かすコンピューターは必要です。LINEには公開HTTPS Webhookが必要です。Your dotのcloud computerに置いた場合の24時間常駐・休止中の接続維持は未検証です。[Cloud computerの条件](docs/cloud-computer.md)

## クイックスタート: Discord + 個人用Codex

Node.js **22.13以上**、npm、Gitが必要です。macOS / Linux、WindowsではWSLなどのPOSIXシェルで以下を実行します。ブリッジ自体に外部npm依存はありません。

```bash
git clone https://github.com/miyashita-code/codex-messaging-bridge.git
cd codex-messaging-bridge
npm ci --ignore-scripts
cp bridge.discord.cloud.example.json bridge.config.json
node --input-type=module -e 'import fs from "node:fs"; const p="bridge.config.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.backend="codex"; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n",{mode:0o600});'
```

[Codex CLIの公式手順](https://learn.chatgpt.com/docs/codex/cli)でCodexを導入し、**自分のChatGPTアカウント**でサインインします。導入済みなら、そのログインを使えます。

```bash
codex login
codex login status
```

[Discord標準セットアップ](docs/discord-setup.md)に従い、Application / Botを作成します。Message Content Intentを有効にし、必要な権限を付けてサーバーへ招待します。Bot tokenは以下の端末入力で保存します。入力内容は表示されません。

```bash
./bin/codex-line-bridge channels add --channel discord
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

Botへ最初のDMを送ります。届いたコードを、別の端末で承認します。`<CODE>` は実際のコードに置き換えます。

```bash
./bin/codex-line-bridge pairing list discord
./bin/codex-line-bridge pairing approve discord <CODE>
```

承認後、もう一度DMで「こんにちは」と送ります。Codexから同じDMに返答が届けば、受信・認証・推論・返信まで接続できています。Gatewayを起動した端末は稼働を続ける必要があります。停止は `Ctrl+C` です。

既存Codexログインの経路はローカル・オープンソース用途向けです。商用・ホスト型サービス用の認証として共有しないでください。[App Serverの認証条件](https://learn.chatgpt.com/docs/app-server)

## Your dot・LINEで使う

- **公開ホスティングを省くDiscord受信箱:** [インストールガイドの受信箱構成](docs/install.md#discord--your-dot受信箱)へ進みます。Your dotは同じcomputerでCLIを使って読取・返信します。
- **新着からYour dotが処理するMCP構成:** [LINE標準セットアップ](docs/line-setup.md)または[Discord標準セットアップ](docs/discord-setup.md)の後、[Your dot接続ガイド](docs/dot-integration.md)に従ってOAuth接続とイベント購読を設定します。
- **LINE + 個人用Codex:** [インストールガイドのLINE構成](docs/install.md#line--個人用codex)へ進みます。

```text
LINE → 署名検証 → SQLite受信箱 → MCP Events → Your dot
Discord → Gateway → SQLite受信箱 → Codex / MCP Events / CLI
LINE・Discord ← 永続送信記録と冪等キー ← 返信
```

Your dotの記憶・接続済みアプリ・作業委譲はYour dot側で管理します。このブリッジはLINE / Discordの入出力を提供します。純正連絡先への追加や、GitHub公開だけでのChatGPTプラグイン公開・審査完了は含みません。

## 設定・運用

`bridge.config.example.json` はLINE + Your dot MCP、`bridge.discord.example.json` はDiscord + Your dot MCP、`bridge.discord.cloud.example.json` はDiscord + headless受信箱の設定例です。コピーして `bridge.config.json` として使い、配布用の例はそのまま残します。`--config PATH` で別の設定も選べます。

トークン類は `.env` に保存し、`${DISCORD_BOT_TOKEN}` などで設定から参照します。`.env`、`bridge.config.json`、`data/`、SQLite、ログはGitから除外しています。Bot tokenやCodexログイン情報をIssue・PR・チャットへ貼らないでください。

DMは既定で `dmPolicy: "pairing"`、グループは `groupPolicy: "allowlist"` です。DM承認とグループの送信者許可は独立しています。Discordサーバーは `guilds`、LINEグループは `groupAllowFrom` / `groups` で許可します。

```bash
./bin/codex-line-bridge gateway status
./bin/codex-line-bridge channels status --probe
./bin/codex-line-bridge queue list
./bin/codex-line-bridge pairing revoke discord default <USER_ID>
```

macOS LaunchAgent、Linux systemd、Caddyの例を `deploy/` に同梱しています。データは既定で `data/`、保存期間は30日、受信キュー上限は10000件です。バックアップはプロセス停止後、SQLite本体と関連ファイルを一緒に保存します。

## 実装範囲・検証

署名検証、Gateway再接続、会話ごとの順序、重複排除、再試行、DMペアリング、グループ許可、メディア取得、返信の分割、送信の冪等性、OAuth / PKCE、MCP Eventsを実装しています。個人用Codexは会話を継続し、承認要求を依頼者へ返します。既定のsandboxは `read-only` です。

OpenClawの全機能を再現する実装ではありません。対応範囲と差分は[LINE互換仕様](docs/openclaw-parity.md)・[Discord互換仕様](docs/discord-parity.md)を参照してください。添付の内容分析は接続先のAIとツールに従います。利用者別のOS隔離やマルチテナントSaaSは含みません。

```bash
npm test
npm run check
CODEX_SMOKE=1 node --test --test-name-pattern='real CLI smoke' tests/codex.test.mjs
```

通常のテストはサービス認証情報を使わず、モックのLINE / Discord / MCP経路を検証します。最後のコマンドは自分のCodexログインを使う実推論の任意検査です。実Bot・Your dotとの往復、cloud computerの継続稼働はそれぞれの実環境で確認します。GitHub ActionsはNode.js 22 / 24 / 26で通常テストと構文チェックを実行します。

持ち込み用アーカイブは `npm run package:cloud` で `data/codex-messaging-bridge-cloud.tar.gz` に生成します。実 `.env`、ローカル設定、認証情報、稼働中DBを含めません。

## English quickstart

Use Node.js **22.13+**, npm, Git and a POSIX shell (macOS, Linux or WSL). Clone this repository and install with `npm ci --ignore-scripts`; there are no external runtime npm dependencies.

For **automatic Discord replies with your personal Codex**, run the commands in the [quickstart above](#クイックスタート-discord--個人用codex): copy `bridge.discord.cloud.example.json` to `bridge.config.json`, change `backend` to `codex`, and sign in to your own Codex CLI. Create a Discord Application / Bot, enable Message Content Intent, invite it with the required permissions, then run:

```bash
./bin/codex-line-bridge channels add --channel discord
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

Send the bot a DM, approve its pairing code in another terminal, then send a second DM to check the AI reply:

```bash
./bin/codex-line-bridge pairing list discord
./bin/codex-line-bridge pairing approve discord <CODE>
```

Discord Gateway needs an active process but no public webhook or domain. For **Your dot without a public endpoint**, keep `backend: "inbox"`; your dot reads and replies through the CLI on the same computer. This inbox mode does not wake your dot when a message arrives. For **Your dot MCP Events**, use `backend: "dot"`, an HTTPS MCP endpoint, OAuth and event subscriptions. LINE always needs an HTTPS webhook receiver. Continuous operation on your dot's cloud computer has not been verified.

See the [installation and profile guide](docs/install.md#english-installation-guide), [Discord setup](docs/discord-setup.md), [LINE setup](docs/line-setup.md) and [Your dot integration](docs/dot-integration.md). Each user supplies their own credentials. Local Codex app-server login is for local / open-source use, subject to [OpenAI's authentication conditions](https://learn.chatgpt.com/docs/app-server).

## License / References

[MIT](LICENSE). This is an independent project; it is not an official OpenAI, LINE, Discord or OpenClaw integration.

- [OpenClaw LINE](https://docs.openclaw.ai/channels/line) / [Discord](https://docs.openclaw.ai/channels/discord/setup)
- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Connect a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Your dot computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
