# Your dot の cloud computer とホスティング

確認日: 2026年10月14日。**Your dot の cloud computer だけに置けば、LINE / Discord のブリッジを24時間運用できる、とは現時点で確認できません。** Discordは公開Webhookを省けます。LINEは公開HTTPSの受信先が必要です。AI秘書であるYour dotの稼働と、外部メッセージを受けるブリッジの稼働は別の要件です。

リポジトリを渡してagentにセットアップを任せる入口は [`AGENTS.md`](../AGENTS.md) と[agentオンボーディング](agent-onboarding.md)です。cloudで設定を準備し、アカウント設定は接続済みlocal PCへ委譲し、cloudで実接続とPC独立性を確認する手順を用意しています。設定準備とcloud常駐の実証は分けて扱います。

```bash
./bin/codex-line-bridge setup plan --target dot-cloud --channel both --mode dot
./bin/codex-line-bridge setup prepare --target dot-cloud --channel both --mode dot
```

private設定は `data/setup/dot-cloud/bridge.config.json`、`.env`、非秘密の再開状態は `setup-state.json` に保存します。既存の稼働設定を上書きせず、不足している設定と検証条件を確認して進めます。

## Cloud computerで確認できること

公式のOpenAI Docsでは、dotに専用のcloud computerとbrowserがあり、利用者のPCがオフでもcloud workを続けられること、利用の間に状態を保持できること、ファイル・ソフトウェア・ブラウザセッションを持つことが説明されています。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

一方、その文書は任意のNode.js daemonの常時稼働、休止中のWebSocket維持、外部から到達できる公開ポートや固定HTTPS URL、再起動時の自動起動を保証していません。これらが不可能と判明したわけではなく、今回の運用に使えるかは未確認です。状態を保存できる説明だけから、起動したBotプロセスも24時間動き続けると判断しません。

## アカウント設定だけlocal PCを使う

Your dotのprofileで **Computers → Your computer → Allow access** を選び、接続を許可します。Your dotはそのcomputerにlocal Work / Codex taskを作り、アカウント設定などの作業を進められます。PCはonlineでChatGPT desktop appを起動しておく必要があります。cloud browserはlocal browserのログインを引き継ぎません。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

localで設定したBotをcloudで動かすには、cloud runtimeにも必要なBot接続secretを安全に設定します。localのCodex login、browser cookie、`.env`全体を移す手順にはしません。現在動くlocal gatewayは、cloudの実行条件と接続を検証して移行するまで維持します。

接続許可は残ってもPCがofflineの間はlocalの作業・serviceを利用できません。既存local taskは自動でcloudへ移動しません。PCの電源に依存しないBotを実現するには、受信・保存・返信のruntimeと必要な接続が実際にcloud側で成立している必要があります。[Local computer access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access)

## 現在のlocal構成と電源・再起動

実機確認済みの構成はmacOS上の個人用Codexです。LINE / DiscordのGatewayとCodex app-serverはlocalで動きます。LINEは公開HTTPS tunnel経由でlocal Webhookへ届きます。Your dotとのcloud MCP接続・イベント購読はまだ実機確認していません。

この構成ではshutdown / sleep / network切断中に受信と返答が止まります。設定したLaunchAgentはログイン後にサービスを起動し、process停止時の復帰も行いますが、PCの電源off中に動くものではありません。実機ではGateway再起動後の承認・会話の継続を確認しており、macOS全体のreboot / loginをまたぐE2E試験とは区別します。配布repoだけでこのMacのprivate service設定が他のcomputerへコピーされることもありません。

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

GitHubからimportしたpluginが `mcp.json`等でMCP serverを宣言している場合、remote HTTPSでもDesktop onlyという制約があります。cloud向けには、そのsurfaceで利用できるcustom MCP connectionやregistered appを実際に接続し、認可と購読まで確認します。manifestを置くだけでcloud接続が作られたとは扱いません。[Plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)

## 自分でサーバーを契約したくない場合

Discordだけを個人用に使うなら、すでにあるコンピューターでGateway接続を動かすことで、Discord受信用の公開サーバー契約とドメインを省けます。`bridge.discord.cloud.example.json` は `backend: inbox`、`transport: headless` で、HTTPポートを開きません。Your dotが同じcomputerでCLIを使って受信箱を読み、同じ会話へ返信できます。OpenAI APIキーやMCPの公開先は使いません。ただし新着受信でYour dotを自動起動する機能はなく、Your dotが受信箱を確認するときに処理します。MCP Eventsによる自動起動を使う場合は、別途MCP接続の経路が必要です。CLIのセットアップでは、自動応答が不要な受信箱方式を選ぶときだけ `--channel discord --mode inbox` を明示します。

Cloud computerへ持ち込むファイルは `npm run package:cloud` で生成できます。実際の `.env`、Bot token、稼働中DB、ローカル設定は含めません。展開後の流れは[Discord標準セットアップ](discord-setup.md)に記載しています。

```bash
./bin/codex-line-bridge cloud-check --probe
./bin/codex-line-bridge --config bridge.discord.cloud.example.json channels add --channel discord
./bin/codex-line-bridge --config bridge.discord.cloud.example.json gateway
```

`cloud-check` はその実行環境のNode/SQLite/WebSocketとDiscordへの外向き接続を確認します。Cloud computerの24時間稼働を保証する検査ではありません。

OpenAIのSecure MCP Tunnelは、private MCPへ外向きHTTPSだけで接続できます。ただし、実行用APIキー、利用権限、稼働し続ける`tunnel-client`が必要です。既存Codexログインだけで利用できると説明された機能ではありません。LINEのWebhookを代わりに受ける機能でもありません。公開プラグインの提出・配布には使えず、その場合は安定した公開HTTPS endpointが必要です。[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

「自分のPCをオフにし、サーバーを一切用意せず、LINE / Discordの両方をYour dotだけで常時受信する」という条件を満たせるかは、今回確認した公式仕様だけでは判断できません。cloud側の実行条件・到達性・継続稼働を確認してから可否を判断します。Your dotの純正連絡方法として公式に案内されているのはChatGPT・通話・Slack・Teamsです。LINE / Discordはこのブリッジを介する追加経路です。[Message your dot](https://learn.chatgpt.com/docs/dots/channels)

## Cloud computerに載せる前の実機確認

cloud computer上での試験は、次を確認してから運用可否を判断します。まだこのアカウントのcloud computer上では実施していません。

1. Node.js 22.13以上とSQLiteを使えるか。ブリッジの設定・DBを再利用できる場所へ保存できるか。
2. DiscordのWSS、各サービスのAPI、MCP Eventsのcallbackへ接続できるか。
3. 会話や作業が止まっている間、Botプロセスとheartbeatが維持されるか。停止後に自動復帰する仕組みがあるか。
4. MCPプラグインからブリッジへ到達し、OAuth・イベント購読・返信まで通るか。
5. LINEを使う場合は、LINEから到達できる安定したHTTPS endpointを設定し、WebhookのVerifyと実メッセージの往復を通せるか。
6. 許可された移行の範囲でowned local bridgeを停止し、local資源を利用しない状態でも新しいメッセージへの返答が届くか。旧endpoint・serviceへ戻せる手順を準備してから試す。PC全体のshutdownや他のserviceの停止は、その操作の許可なしに行わない。

短い起動試験に成功しても、休止・再起動をまたいだ常時稼働の保証にはなりません。最後にLINE / Discord → Your dot → 同じ会話への返信を、各実アカウントで確認する必要があります。
