# Your dot の cloud computer とホスティング

更新日: 2026年10月16日。現在のクラウド実験構成は **Sites Worker/D1 + native cloud Work task** です。LINEは公開Webhookで受信し、DiscordはMCP待受中にRESTで回収します。返信の推論は利用者が許可したcloud Work taskが行います。Your dot本人のイベント処理、個人記憶、Codex Cloudとは区別します。各利用者のSites・接続・cloud taskの利用権限と上限を確認する必要があります。

この構成では追加hosting契約やOpenAI APIキーを使わず、対象のlocal受信サービス・tunnel停止、browser tickのstandby、localのcloud chat panel閉鎖後の実LINE / Discord返信を確認しました。物理的なPC電源断、無期限常駐、全UIを閉じた状態からの自動cold restartは未検証です。導入は[Sitesガイド](../adapters/sites/README.md#first-party-cloud-task-receiver-experimental)と[接続ガイド](dot-integration.md#first-party-cloud-taskで待機返信する実験経路)に従います。Node Gatewayをcloud computerに置く方式は別の構成です。

## クラウド実験構成の実測（2026年10月15日）

| 確認した経路・機能 | 結果と範囲 |
| --- | --- |
| LINE → cloud Work → 同じ会話 | 通常の観測では約6–10秒。別の入力では約68–70秒かかり、そのうち約62–63秒がcloud保存前の遅延だった。最初に保存された受信がredeliveryだった例もあり、公開受信経路の遅延原因は未特定。 |
| Discord → cloud Work → 同じ会話 | 約10–21秒の観測があり、後の本人DMは11.899秒。local受信停止、cloud chat panel閉鎖後の新規入力でも返信した。常時この時間で返せる保証ではない。 |
| 追加Discordサーバー | 同じBotのサーバー別profile・許可チャンネルを設定し、メンション返信と既存本人DMの維持を確認。会話履歴をサーバー・チャンネルごとに分離し、別サーバーの履歴を回答へ流用しないことも確認した。 |
| Botの管理ロール宛メンション | 実際のBot用managed roleを検証し、取りこぼしていた議事録の依頼を回収。同じ会話への返信が完了した。本文読取からAPI配送完了までは28.971秒で、元の投稿時刻からの応答時間ではない。 |
| 議事録資料の読取 | 公開スレッド3件と、実際のメッセージに付いたUTF-8テキスト/Markdown添付4件を読み、添付の最終ページまで取得したことを確認。資料読取の検証であり、スレッド内の新規投稿から自動返信までのE2Eとは別。 |

これらは個別の実通信の観測で、他アカウントでの動作、最大応答時間、24時間連続運転を保証しません。新規スレッド入力から同じスレッドへの返信、task中断後の全UI閉鎖状態からの自動復帰、物理PC電源断は別途確認が必要です。既存の毎時復旧taskは維持していますが、高速受信が止まると次の復旧まで待つ場合があり、実行自体も遅延・失敗し得ます。

Your dot本人が返信する **Sites + MCP Events** 経路も実装し、同日に実往復を確認しています。こちらはイベント通知後に約10分待った例があります。後半の[移行検証](#sitesでの移行検証2026年10月15日)は、この先行するevent/browser構成の記録です。現在のcloud Work実験の待受方式と混ぜて読まないでください。

リポジトリを渡してagentにセットアップを任せる入口は [`AGENTS.md`](../AGENTS.md) と[agentオンボーディング](agent-onboarding.md)です。cloudで設定を準備し、アカウント設定は接続済みlocal PCへ委譲し、cloudで実接続とPC独立性を確認する手順を用意しています。設定準備とcloud常駐の実証は分けて扱います。

```bash
./bin/codex-line-bridge setup plan --target dot-cloud --channel both --mode dot
./bin/codex-line-bridge setup prepare --target dot-cloud --channel both --mode dot
```

上のコマンドはNode版の計画と設定の準備です。private設定は `data/setup/dot-cloud/bridge.config.json`、`.env`、非秘密の再開状態は `setup-state.json` に保存します。Sitesへの配備やcloud Work taskの接続は行いません。既存の稼働設定を上書きせず、選んだ構成の不足条件を確認して進めます。

## Cloud computerで確認できること

公式のOpenAI Docsでは、dotに専用のcloud computerとbrowserがあり、利用者のPCがオフでもcloud workを続けられること、利用の間に状態を保持できること、ファイル・ソフトウェア・ブラウザセッションを持つことが説明されています。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

一方、その文書は任意のNode.js daemonの常時稼働、休止中のWebSocket維持、外部から到達できる公開ポートや固定HTTPS URL、再起動時の自動起動を保証していません。今回の試験結果はcloudの実行環境ごとに異なり、必要な条件がすべて成立する構成はまだ確認できていません。状態を保存できる説明だけから、起動したBotプロセスも24時間動き続けると判断しません。

## アカウント設定だけlocal PCを使う

Your dotのprofileで **Computers → Your computer → Allow access** を選び、接続を許可します。Your dotはそのcomputerにlocal Work / Codex taskを作り、アカウント設定などの作業を進められます。PCはonlineでChatGPT desktop appを起動しておく必要があります。cloud browserはlocal browserのログインを引き継ぎません。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

localで設定したBotをcloudで動かすには、cloud runtimeにも必要なBot接続secretを安全に設定します。localのCodex login、browser cookie、`.env`全体を移す手順にはしません。現在動くlocal gatewayは、cloudの実行条件と接続を検証して移行するまで維持します。

接続許可は残ってもPCがofflineの間はlocalの作業・serviceを利用できません。既存local taskは自動でcloudへ移動しません。PCの電源に依存しないBotを実現するには、受信・保存・返信のruntimeと必要な接続が実際にcloud側で成立している必要があります。[Local computer access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access)

## 移行前のlocal構成と電源・再起動

以下は2026年10月14日までの移行前の記録です。当時の実メッセージ検証はmacOS上の個人用Codex構成でした。LINE / DiscordのGatewayとCodex app-serverはlocalで動き、LINEは公開HTTPS tunnel経由でlocal Webhookへ届いていました。所有者限定SiteのMCPプラグインはインストール・OAuth接続を完了し、認証済みの状態取得を確認しました。Your dot側からも状態取得成功とイベントソースの表示が報告されています。この時点では、イベント購読とcloudでの自動返信は未検証でした。

この構成ではshutdown / sleep / network切断中に受信と返答が止まります。設定したLaunchAgentはログイン後にサービスを起動し、process停止時の復帰も行いますが、PCの電源off中に動くものではありません。実機ではGateway再起動後の承認・会話の継続を確認しており、macOS全体のreboot / loginをまたぐE2E試験とは区別します。配布repoだけでこのMacのprivate service設定が他のcomputerへコピーされることもありません。

## LINEとDiscordの違い

| 経路 | 必要なもの | 公開HTTPS受信先 |
| --- | --- | --- |
| LINE → ブリッジ | LINEからのWebhookを受けるプロセス | 必要 |
| Discord → Node版ブリッジ | Discord Gatewayへの外向きWebSocket接続を保つプロセス | Botのメッセージ受信には不要 |
| Discord → Sites版ブリッジ | 許可済み会話をRESTで回収するcloud task、またはevent構成のcloud browser / 復旧task | SitesのMCP接続先を利用 |
| Your dot → ブリッジ | MCPプラグインの接続先とOAuth認可 | 公開HTTPS、または対応するprivate MCP tunnel |
| ブリッジ → Your dot | MCP Eventsの購読と、署名付きcallbackへの外向きHTTPS | callbackはChatGPTが指定 |
| 同じcomputerの受信箱 → Your dot | `backend: inbox` のCLIで読取・返信 | 不要。イベントによる自動起動は行わない |

LINE Messaging APIは登録済みのBotサーバーへWebhookを送ります。そのURLにはHTTPSと信頼された認証局の証明書が必要です。新着テキストを後から取得するAPIは用意されていません。このため受信先を完全に省く構成は成立しません。[Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[Receive messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

Discord GatewayはBotからDiscordへsecure WebSocket接続を開き、イベントを受けます。公開ドメインやWebhook受信先を用意せずにメッセージを受信できます。ただしheartbeat、切断時の再接続、Botプロセスの稼働は必要です。[Discord Gateway](https://docs.discord.com/developers/events/gateway)

MCP Eventsはdotsに対応しています。ブリッジ側が購読を保存し、ChatGPTから指定されたHTTPS callbackを検証して、署名付きイベントを届けます。Discordの受信をGateway方式にしても、Your dotへのこの接続が自動で用意されるわけではありません。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

GitHubからimportしたpluginが `mcp.json`等でMCP serverを宣言している場合、remote HTTPSでもDesktop onlyという制約があります。cloud向けには、そのsurfaceで利用できるcustom MCP connectionやregistered appを実際に接続し、認可と購読まで確認します。manifestを置くだけでcloud接続が作られたとは扱いません。[Plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)

## 自分でサーバーを契約したくない場合

Sitesが利用できるアカウントでは、[Sites adapter](../adapters/sites/README.md)を先に評価します。公開LINE WebhookとD1への保存をSitesに置き、Discordは許可済み会話のREST回収を行います。返信担当にはYour dotのMCP Events経路と、利用者が明示的に許可したnative cloud Work taskの実験経路があります。後者はMCP待受中に回収し、有効化中のbrowser tickはstandbyです。前者はcloud browserによる15秒回収や復旧taskを使います。どちらも利用可能な機能と継続稼働を実環境で確認します。以下のNode CLI受信箱方式とは別です。

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

Sitesの公式pluginには、Siteのnative MCP server、HTTP handler、D1を使う構成があり、移植先の候補です。公開仕様でもHTTP / HTTPS / WebSocketとD1が案内されています。[Sites](https://learn.chatgpt.com/docs/sites) 所有者限定のSite上では、実HTTPリクエストの処理中にDiscordのHTTPSと未認証WSSのHELLO受信を確認しました。通常のDiscord Gateway常駐は未検証です。10月15日にSites版のREST回収とMCP Events実購読・返信を確認した結果は次節に記載します。privateなfrontdoorを用意しただけでは、受信プロセスの継続稼働や新着からのdot起動を確認したことにはなりません。

LINEには、ChatGPTへのサインインなしでPOSTを受けられるHTTPS入口も必要です。所有者限定のSiteは認証を要求し、LINEのWebhook設定にはSiteのサービス認証ヘッダーやChatGPTへのログインを指定する契約がありません。private SiteのURLへの差し替えだけでは受信を確認できません。署名を検証する承認済みの公開入口、またはraw bodyと署名を保持してprivate側へ認証付き転送する経路を用意します。Siteの公開範囲や認証を自動で変更して、この条件を解消したことにはしません。[LINE Webhook](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)、[Webhook設定API](https://developers.line.biz/en/reference/messaging-api/nojs/#set-webhook-endpoint-url)

## Sitesでの移行検証（2026年10月15日）

以下は同日の先行する **Your dot + MCP Events / cloud browser回収** の検証記録です。現在のcloud Work実験の構成・結果は冒頭を参照してください。

本人用Site-created pluginを接続し、LINE・Discord DM・Discordメンションの3種類のMCP Events購読を確認しました。LINE入口だけを署名検証付きで公開し、MCPと運用画面は本人認証を維持しています。必要なBot接続secretだけをSitesのprivate runtime設定へ移し、Codexログイン・cookie・会話DBは移していません。

| 試験 | 実測結果 |
| --- | --- |
| LINE公開受信 | 公式Webhook Verify成功。MacのLINEサービスとtunnelを停止後、15:16の本人メッセージをSitesが受信・保存し、dotが自動起動。15:17に計算結果「437」と照合文字列を同じLINE会話へ返信。続く通常メッセージにも返信した。 |
| Discordメンション | MacのDiscordサービスを15:22に未処理0件で停止。本人が15:42に送ったBotメンションをcloudが回収し、15:43にdotから同じ発言への返信を公式Discord APIで確認した。 |
| Discord本人DM | Macの両受信サービス停止・自動起動無効、cloud受信タブ1つを開いた状態で試験。17:23:43の本人DM「53×17答え数字だけ」を17:23:55に回収し、17:23:57にcallbackが受理された。17:24:38にdotから同じDMへ「901」が到着。Discord実画面と、D1の返信記録1件が `completed` であることを確認した。 |
| 再配備 | secret、D1、購読を維持したままSites v13へ再配備成功。その後のDiscord実返信が成功した。 |
| Mac再起動時の競合防止 | 実返信確認後、旧LINE / Discord LaunchAgentの自動起動も無効化。privateの復元手順と旧設定は保持した。Mac全体の再起動は実施していない。 |
| 復旧処理 | MCP経由の `bridge_maintain` を実行してD1への実行記録を確認。browser tickとMCP実行を分けて記録する。 |
| 復旧スケジュール | 試験アカウントでは5分間隔が「1時間に1回まで」と拒否され、毎時スケジュールを設定。Scheduledの実行履歴で15:20のMCP回収成功を確認。タブ停止後にも16:17のcloud MCP実行記録があるが、この実行のschedule帰属は未確認。16:37の「今すぐ実行」では、タブとMac受信を停止したままMCP回収が成功した。定期実行の継続性とは区別する。 |
| 受信タブ停止後のLINE | 15:44にcloud受信タブを閉じ、Mac受信も停止したまま、16:01の新規計算依頼へ16:11にdotから「481」と照合文字列が到着。追いかけの返信指示なしで往復を確認した。 |
| 通知受理後のLINE滞留 | v15の `line_inbox_read` を実クラウドtaskから呼び、未返信の承認済み入力を列挙・読み取りできた。確認用文字列を含む返信は自動承認審査に拒否されたため、その文字列を含めない計算結果「451」だけへ変更し、16:39に同じLINE会話へ送信した。これは手動起動・追加指示を伴う復旧経路の検証で、通常のdot自動返信成功には数えない。 |
| 保存した復旧taskの返信 | 16:39の新しい自然文の計算依頼は、通知受理後6分以上返信がなかった。既存taskの「今すぐ実行」で回収→未返信一覧→本文読取→返信まで進み、16:46に同じLINEへ「611」が到着。task起動後の追加の返信指示は不要だった。Mac受信とcloud受信タブは停止したまま。手動起動による復旧試験であり、毎時実行の継続性や通常イベント経路の成功とは区別する。 |

この試験では、スケジュールtaskからcloud受信タブを再度開く操作が `ERR_BLOCKED_BY_CLIENT` で拒否されました。既存スケジュールは、実行できたMCP回収だけを行う指示へ修正しました。受信タブの自動再開は確認済み機能として扱いません。

このevent/browser構成のDiscord高速回収はdotのcloud browserタブが開いている間に動きます。タブが閉じた場合の返信はスケジュールの頻度・実行遅延に影響され、常時即時返信を保証しません。LINEはタブが閉じてもWebhookで受信・保存し、受信処理から通知を試みます。通知失敗は永続キューに残り、復旧処理が再試行します。通知の2xx受理後のdot処理は非同期で、今回の新規LINEには約10分の待ち時間がありました。即時返信や最大待ち時間の保証ではありません。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

ここでのPC独立性試験は、**owned local受信サービス・tunnelを停止し、localhostの受信口を利用できなくした状態**です。物理的なPC電源断、Wi-Fi切断、24時間連続稼働とは区別します。Discordのメンションと本人DMはcloud受信タブを開いた状態で実返信を確認しました。タブ停止後の定期回収・返信は引き続き未検証です。公開repoにはprivateのaccount ID・token・会話データを含めません。

## Cloudでの試験結果と残る確認

以下は2026年10月14日時点の調査記録です。現在のSites / cloud Work実験の結果は冒頭を参照してください。dotのdesktop computer、会話中のcode runtime、保存済みCloud environmentの別task、SitesのWorkerは別の実行環境です。desktopのterminal実観測、dot・別taskからの実行報告、Siteへの実HTTPリクエストの計測を分けて記録します。

| 環境・証拠 | 準備・通信の結果 | 保存・継続の結果 |
| --- | --- | --- |
| dotのdesktop computer（terminal実観測） | Node.jsなし。GitHub、nodejs.org、DiscordへのHTTPS（443）接続が失敗。 | この環境ではブリッジ起動・常駐を未検証。 |
| dot会話のcode runtime（dotの試験報告） | Node.js 24.19。v0.2.0（`32282a8`）をcloneし、setup planは `ready:false`。`cloud-check --probe` と未認証Discord WSSのHELLO受信は成功。 | private SQLiteを別の完了turn後に再読。background起動元のコマンド終了後にheartbeatが停止。公式cloudflaredのQuick TunnelはDNSのUDP接続が `network unreachable` で停止し、URLを発行できず。 |
| 保存済みCloud environmentの別task（別taskの実行ログ） | Node.js 24.19、clone・setup plan成功（`ready:false`）。Discordは `EAI_AGAIN`、proxyのCONNECTは403、WSSは失敗。 | 同一processが完了turnをまたいで約95秒・19 heartbeat継続し、privateファイルの600権限を維持。環境の再起動をまたぐ復帰は未測定。 |
| 所有者限定SiteのWorker（実HTTPリクエストの計測、04:11 UTC） | Discord discoveryのHTTPSは200、Gateway WSSは101、未認証の `op:10` HELLO受信に成功。Bot接続secretは使用せず、Identifyは送信していない。 | 1回のHTTPリクエスト中の短時間probe。自身のsocketにcloseを要求して終了し、heartbeat・background worker・常駐・再起動は未検証。 |
| dotのcloud browser → 所有者限定Site（dotの画面結果とSiteの呼出記録、16:36–16:37 JST） | 通常の本人サインイン後、受信WebSocketを45秒ずつ2回開き、各9件・計18件の診断フレームを受信。画面結果は `two_windows_complete`、両方のclose codeは1000。 | 約92秒の接続と再接続を確認。タブの公式保持操作が必要だった。Siteの呼出記録には両socketの約45秒の実行があるが、outcomeは `exception` で詳細原因は取得できず。Bot受信・無人常駐・自動復旧の実証には含めない。 |

Sitesで最初に出た `TypeError` は、workerdの `fetch` で `redirect: 'error'` を使ったときの互換性問題でした。`redirect: 'manual'` と明示的な3xx拒否へ変更した後、上記の通信が成功しました。[workerdの公式実装](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.c%2B%2B#L446-L450) この初回エラーや、別のcloud環境での通信失敗を根拠に、Sites全体のDiscord向け通信が遮断されているとは判断しません。実測が確認したのは処理中の外向き通信で、`runtimeVerified` と `uptimeVerified` はともに `false` です。

同日16:05 JST、Your dotは接続済みSiteの認証付き `bridge_status` 呼び出し成功とイベントソース表示を報告しました。状態は `owner_configured: true`、`guild_configured: true`、`companion_configured: false`、`backend_connected: false`、`dot_auto_wake: false` で、ローカルのエージェントから行った実際の接続ツール呼び出しとも一致しました。これはMCP入口が使えることの確認です。イベントの実購読・受信プロセスの継続・実メッセージへの返信は、引き続き別に検証します。ブラウザでSiteへログインするセッションとMCPのOAuth接続も別であり、一方の成功をもう一方の認証済み状態として扱いません。

短時間のブラウザ試験では、最初のタブが結果回収前に自動終了しました。提供された `markHandoff` で試験タブを保持してやり直すと、上表の2回の接続結果を回収できました。これは公式のタブ保持操作による診断であり、ブラウザやプロセスの終了管理を変更していません。終了後は試験タブを閉じ、期間限定の診断経路を無効化しました。ブラウザを開いている間の接続成功だけから、管理された常駐サービスや再起動後の自動復旧が用意されたとは判断しません。

未認証WSSのHELLO、設定生成、短時間のprocess継続は、Botの認証・実メッセージ受信・Your dotの返信・24時間稼働の証拠にはしません。既存localの実往復とgateway復帰の確認は、cloudでの往復やPC off時の稼働と区別します。**この10月14日時点ではcloud実往復は未完了でした。** 10月15日のSites実往復とは分け、Node daemon方式を新たに選ぶ場合は次の条件を引き続き確認します。

1. Node.js 22.13以上とSQLiteを使えるか。ブリッジの設定・DBを再利用できる場所へ保存できるか。
2. DiscordのWSS、各サービスのAPI、MCP Eventsのcallbackへ接続できるか。
3. 会話や作業が止まっている間、Botプロセスとheartbeatが維持されるか。停止後に自動復帰する仕組みがあるか。
4. MCPプラグインからブリッジへ到達し、OAuth・イベント購読・返信まで通るか。
5. LINEを使う場合は、LINEから到達できる安定したHTTPS endpointを設定し、WebhookのVerifyと実メッセージの往復を通せるか。
6. 許可された移行の範囲でowned local bridgeを停止し、local資源を利用しない状態でも新しいメッセージへの返答が届くか。旧endpoint・serviceへ戻せる手順を準備してから試す。PC全体のshutdownや他のserviceの停止は、その操作の許可なしに行わない。

短い起動試験に成功しても、休止・再起動をまたいだ常時稼働の保証にはなりません。最後にLINE / Discord → Your dot → 同じ会話への返信を、各実アカウントで確認する必要があります。
