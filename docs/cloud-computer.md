# Your dot の cloud computer とホスティング

確認日: 2026年10月13日。**Your dot の cloud computer だけに置けば、LINE / Discord のブリッジを24時間運用できる、とは現時点で確認できません。** Discordは公開Webhookを省けます。LINEは公開HTTPSの受信先が必要です。AI秘書であるYour dotの稼働と、外部メッセージを受けるブリッジの稼働は別の要件です。

## Cloud computerで確認できること

公式のOpenAI Docsでは、dotに専用のcloud computerとbrowserがあり、利用者のPCがオフでもcloud workを続けられること、利用の間に状態を保持できること、ファイル・ソフトウェア・ブラウザセッションを持つことが説明されています。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

一方、その文書は任意のNode.js daemonの常時稼働、休止中のWebSocket維持、外部から到達できる公開ポートや固定HTTPS URL、再起動時の自動起動を保証していません。これらが不可能と判明したわけではなく、今回の運用に使えるかは未確認です。状態を保存できる説明だけから、起動したBotプロセスも24時間動き続けると判断しません。

## LINEとDiscordの違い

| 経路 | 必要なもの | 公開HTTPS受信先 |
| --- | --- | --- |
| LINE → ブリッジ | LINEからのWebhookを受けるプロセス | 必要 |
| Discord → ブリッジ | Discord Gatewayへの外向きWebSocket接続を保つプロセス | Botのメッセージ受信には不要 |
| Your dot → ブリッジ | MCPプラグインの接続先とOAuth認可 | 公開HTTPS、または対応するprivate MCP tunnel |
| ブリッジ → Your dot | MCP Eventsの購読と、署名付きcallbackへの外向きHTTPS | callbackはChatGPTが指定 |
| 同じcomputerの受信箱 → Your dot | `backend: inbox` のCLIで読取・返信 | 不要。イベントによる自動起動は行わない |

LINE Messaging APIは登録済みのBotサーバーへWebhookを送ります。そのURLにはHTTPSと信頼された認証局の証明書が必要です。新着テキストを後から取得するAPIは用意されていません。このため受信先を完全に省く構成は成立しません。[Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[Receive messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

Discord GatewayはBotからDiscordへsecure WebSocket接続を開き、イベントを受けます。公開ドメインやWebhook受信先を用意せずにメッセージを受信できます。ただしheartbeat、切断時の再接続、Botプロセスの稼働は必要です。[Discord Gateway](https://docs.discord.com/developers/events/gateway)

MCP Eventsはdotsに対応しています。ブリッジ側が購読を保存し、ChatGPTから指定されたHTTPS callbackを検証して、署名付きイベントを届けます。Discordの受信をGateway方式にしても、Your dotへのこの接続が自動で用意されるわけではありません。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

## 自分でサーバーを契約したくない場合

Discordだけを個人用に使うなら、すでにあるコンピューターでGateway接続を動かすことで、Discord受信用の公開サーバー契約とドメインを省けます。今回追加した `bridge.discord.cloud.example.json` は `backend: inbox`、`transport: headless` で、HTTPポートを開きません。Your dotが同じcomputerでCLIを使って受信箱を読み、同じ会話へ返信できます。OpenAI APIキーやMCPの公開先は使いません。ただし新着受信でYour dotを自動起動する機能はなく、Your dotが受信箱を確認するときに処理します。MCP Eventsによる自動起動を使う場合は、別途MCP接続の経路が必要です。

Cloud computerへ持ち込むファイルは `npm run package:cloud` で生成できます。実際の `.env`、Bot token、稼働中DB、ローカル設定は含めません。展開後の流れは[Discord標準セットアップ](discord-setup.md)に記載しています。

```bash
./bin/codex-line-bridge cloud-check --probe
./bin/codex-line-bridge --config bridge.discord.cloud.example.json channels add --channel discord
./bin/codex-line-bridge --config bridge.discord.cloud.example.json gateway
```

`cloud-check` はその実行環境のNode/SQLite/WebSocketとDiscordへの外向き接続を確認します。Cloud computerの24時間稼働を保証する検査ではありません。

OpenAIのSecure MCP Tunnelは、private MCPへ外向きHTTPSだけで接続できます。ただし、実行用APIキー、利用権限、稼働し続ける`tunnel-client`が必要です。既存Codexログインだけで利用できると説明された機能ではありません。LINEのWebhookを代わりに受ける機能でもありません。公開プラグインの提出・配布には使えず、その場合は安定した公開HTTPS endpointが必要です。[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

「自分のPCをオフにし、サーバーを一切用意せず、LINE / Discordの両方をYour dotだけで常時受信する」という条件は、今回確認した公式仕様だけでは満たせません。Your dotの純正連絡方法として公式に案内されているのはChatGPT・通話・Slack・Teamsです。LINE / Discordはこのブリッジを介する追加経路です。[Message your dot](https://learn.chatgpt.com/docs/dots/channels)

## Cloud computerに載せる前の実機確認

cloud computer上での試験は、次を確認してから運用可否を判断します。まだこのアカウントのcloud computer上では実施していません。

1. Node.js 22.13以上とSQLiteを使えるか。ブリッジの設定・DBを再利用できる場所へ保存できるか。
2. DiscordのWSS、各サービスのAPI、MCP Eventsのcallbackへ接続できるか。
3. 会話や作業が止まっている間、Botプロセスとheartbeatが維持されるか。停止後に自動復帰する仕組みがあるか。
4. MCPプラグインからブリッジへ到達し、OAuth・イベント購読・返信まで通るか。
5. LINEを使う場合は、LINEから到達できる安定したHTTPS endpointを設定し、WebhookのVerifyと実メッセージの往復を通せるか。

短い起動試験に成功しても、休止・再起動をまたいだ常時稼働の保証にはなりません。最後にLINE / Discord → Your dot → 同じ会話への返信を、各実アカウントで確認する必要があります。
