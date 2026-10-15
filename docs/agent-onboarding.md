# リポジトリをYour dotへ渡してセットアップする

このリポジトリをYour dotへ渡すときの入口は、ルートの [`AGENTS.md`](../AGENTS.md) です。Codexはこの名前のファイルを作業開始前に読みます。Your dotへ渡す際も、以下の指示で明示的に読ませます。[公式のAGENTS.md案内](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

目指す流れは **cloud側で準備 → 接続済みlocal PCでアカウント設定 → cloud側で接続・実機確認 → PCに依存しない稼働の確認** です。Sites版では、2026-10-15にローカル受信サービスを停止した実LINE / Discordメンション・本人DMへのYour dot自動返信を確認しました。Discordはcloud受信タブを開いた状態の試験で、タブ停止後の定期回復・物理PC電源断・24時間連続稼働は未検証です。任意のNode daemonをcloud computerに置く方式とは分け、各利用者の環境で復旧・購読・実返信まで検証します。[実測記録](cloud-computer.md#sitesでの移行検証2026年10月15日)

## そのまま渡せる依頼

```text
https://github.com/miyashita-code/codex-messaging-bridge

このrepoのAGENTS.mdとdocs/agent-onboarding.mdを読んで、
あなたのcloud computerでLINEとDiscordのAI秘書をセットアップして。
アカウント作成やログイン済みブラウザが必要な設定は、接続済みの私のlocal PCを使って進めて。
認証情報はチャットやGitHubへ出さず、必要なものだけ安全なprivate設定へ保存して。
既存Botがあれば再利用し、稼働中の接続を確認してから移行して。
私のPCをオフにしても新しいメッセージを受信して返答できることまで確認してほしい。
有料hostingの契約やOpenAI APIキーの新規作成は希望していません。
自動で進められる部分は進め、本人操作が必須のステップだけ具体的に知らせて。
```

```text
https://github.com/miyashita-code/codex-messaging-bridge

Read AGENTS.md and docs/agent-onboarding.md, then set up my LINE and Discord
AI secretary on your cloud computer. Use my connected local computer for
account setup and authenticated browser steps when needed. Keep credentials
out of chat and Git, and save only necessary secrets in private runtime settings.
Reuse existing bots and preserve their working connection until a verified cutover.
Verify new messages and replies without relying on my laptop. I do not want
to purchase hosting or create an OpenAI API key. Continue the steps you can
complete; identify only the specific steps that require my participation.
```

LINEのみなら「LINEとDiscord」を「LINE」に変えます。Discordのみなら `--channel discord` を使います。既存Botがある場合はその旨を伝えます。tokenやpasswordを依頼文へ貼る必要はありません。

## Cloud computerを開く入口

local Codexから始める場合、通常のChatGPT web画面を操作できる許可済みbrowser toolがあれば、利用者にcloud画面を開くよう依頼する前に、その入口を確認します。native appが保護対象として操作を拒否された場合、別のnative driverで同じappを操作して回避しません。通常のwebサイトを操作する独立した許可済み経路だけを使います。

1. [ChatGPT](https://chatgpt.com/)を対応browserで開きます。Codex appの `open_in_codex` が実在する場合は、`target: { type: "browser", url: "https://chatgpt.com/" }` を使えます。呼び出し元chatが非表示で `queued` になった場合、対応する `navigate_to_codex_page` でそのchatを表示し、開いたbrowserを確認します。
2. browser toolの文書にある操作で、読み込み後のaccount画面を確認します。最初のloadingやsign-in表示だけで未ログインと断定せず、状態を再確認します。ログイン済みであることや他browserから認証を引き継ぐことも推測しません。
3. 画面上の **Your dot** から利用者の対象dotを選び、profile → **Computers → Open computer → Take over** と進みます。表示されていないdeep linkや内部APIは推測しません。cookieやloginファイルをコピーしません。本人のsign-in等が必要になった場合は、そのtoolのprivate handoff規則に従います。

profileからcloud computerを開き、`Take over` で操作し、作業をdotへ戻すときに `Return control` を選ぶ流れは公式に案内されています。画面を開けたことは、Node・外向き通信・常駐・実メッセージ往復の成功を意味しません。引き続き以下の実行条件を確認します。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

## hosting契約を増やさない場合はSitesを先に評価する

Sitesが利用できる場合、[Sites adapter](../adapters/sites/README.md)のnative Site・plugin・D1・クラウドスケジュールの手順を使います。以下のNode用 `setup plan` / `setup prepare` は計画と再開状態の準備であり、Sitesを作成・公開するコマンドではありません。Sitesの実行コードとschemaは `adapters/sites/` にあります。

1. 利用者の既存Siteがあれば再利用し、なければSitesの正規手順で作成します。作者のSite IDや接続先をコピーしません。
2. 必要なBot secretと確認済み送信者だけをprivate runtime settingsへ設定し、Site-created pluginを本人のdotへ接続します。
3. [Sites固有のMCP schema](dot-integration.md#sites版の接続)で購読します。Node版のツール名・引数と混ぜません。
4. LINEの公開受信口、Discordのcloud回収、nativeクラウド復旧スケジュールを用意します。実アカウントの実行頻度制限を確認し、複数のずらしたscheduleで回避しません。
5. 既存local受信を協調停止し、各channelの実返信を検証します。成功したchannelだけ旧serviceの自動起動も無効にし、再起動時のWebhook奪い返し・二重返信を防ぎます。rollbackには再有効化も含めます。
6. 受信タブを閉じた後の復旧を実行履歴・永続記録・実返信で確認します。schedule保存やbrowser timerだけを常駐の証拠にしません。

## 1. Cloudで計画とprivate設定を準備する

cloud computerでこのrepoを取得し、Node.js 22.13以降を確認します。対応するshellやファイル操作が利用できることを、実際のtoolで確認します。

```bash
node --version
./bin/codex-line-bridge setup plan --target dot-cloud --channel both --mode dot
./bin/codex-line-bridge setup prepare --target dot-cloud --channel both --mode dot
```

出力先を明示する場合:

```bash
./bin/codex-line-bridge setup prepare --target dot-cloud --channel both --mode dot --output-dir data/setup/dot-cloud
```

次のprivateファイルを準備します。`data/` はGitと配布アーカイブの対象外です。既存設定がある場合は内容を画面へ出さず、同じパスを使って再開します。

| ファイル | 用途 |
| --- | --- |
| `data/setup/dot-cloud/bridge.config.json` | LINE / Discord、backend、保存先の設定 |
| `data/setup/dot-cloud/.env` | 実行環境で使うBot認証情報・管理者接続設定 |
| `data/setup/dot-cloud/setup-state.json` | セットアップを再開するための非秘密の状態 |

新規設定のペアリングコードは期限なしです。承認済み接続は明示的な取り消しまで保持します。設定生成はBot作成、cloudへの配備、MCPの登録、イベント購読や常駐の成功を意味しません。

再利用した設定のコード期限は `prepare` が自動変更しません。期限なしを依頼されている場合、対象channelとaccountの上書きを確認し、その `pairingCodeTtlMs` だけを `null` に変更します。他の設定・secret・承認DBを維持し、稼働中なら未処理作業を終えてowned runtimeだけを安全に再起動して反映します。変更は新しく発行するコードに適用され、承認済み接続は維持されます。

準備がパスや権限のエラーで止まった場合、リンク先を追って書き込んだり既存ファイルを置き換えたりしません。対象がこのセットアップの所有する通常ファイル・ディレクトリと確認できる場合は、その対象だけをprivateな権限へ直して再実行できます。共有領域や別用途の設定なら、privateなcheckoutまたは別の `data/setup/` 出力先を選びます。channel / modeの競合は既存設定を初期化せず、元の選択で再開するか別の出力先を使います。

Your dotがrepo専用のCodex cloud taskを使う場合、repoとsetupを持つcloud environmentを先に作成します。Your dotの選択computerを変えても既存taskは移動しません。cloud environmentのinstall scriptは依存関係を用意し、start skillはサービス起動とready確認の指示に使えます。[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)、[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)

## 2. Cloudの実行条件を確認する

```bash
./bin/codex-line-bridge cloud-check --probe
```

このコマンドはNode / SQLite / WebSocketとDiscord向け外向き接続を調べます。次の全条件は、このコマンドの成功だけでは確定しません。

| 条件 | 完了判断に必要な確認 |
| --- | --- |
| 永続データ | 設定・DB・購読・返信状態を保存するprivate領域を確認し、再起動後に同じ領域を読める |
| 外向き通信 | 有効なチャネルのAPI、Discord WSS、ChatGPTのevent callbackへ到達する |
| process継続 | taskが終わった後も受信プロセスと必要なheartbeatが動く |
| 復帰 | 環境でサポートされた起動・再起動方法があり、状態を維持して復帰する |
| LINE受信 | LINEから到達できるHTTPS Webhook、信頼できるTLS証明書、維持できるURLがある |
| dot接続 | cloud側で利用できるMCP接続、OAuth、read/write scope、実イベント購読がある |
| PC独立性 | local bridgeとlocal資源が利用できない状態でも新規受信→dot→返信が成功する |

`nohup`やbackground起動が成功したこと、stateファイルが残っていることだけで24時間稼働を判断しません。Your dot自身のcloud workはPCがoffでも続きますが、任意のdaemonや公開portの保証とは別です。制約が見つかったら具体的な不足を記録し、アカウント設定など独立してできる作業を続けます。自動で有料hostingを契約したり、local稼働へ変更したりしません。[Cloud computerの条件](cloud-computer.md)

実行環境ごとに結果を分けます。2026年10月14日の所有者限定Sites Workerでは、HTTPリクエスト処理中のDiscord HTTPSと未認証WSSのHELLO受信が成功しました。dotのdesktop computerや別のcloud taskの通信結果を、そのままSitesへ当てはめません。この短時間probeもBot認証・heartbeat継続・イベント購読・実返信の完了には含めません。[環境別の実測](cloud-computer.md#cloudでの試験結果と残る確認)

## 3. Local PCでアカウント設定を進める

Your dotのprofile → **Computers → Your computer → Allow access** で接続できます。local作業中はPCをonlineにし、ChatGPT desktop appを起動しておきます。この許可はCodexのcomputer接続やWork Syncとは別です。Your dotは、接続済みcomputerにlocal Work / Codex taskを作り、必要な設定を進められます。[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

agentは利用環境に実在する接続・委譲toolを使います。手順に架空のAPIを埋め込んだり、local browserのログインがcloud browserへ移ったと判断したりしません。local taskには対象Bot、作業内容、必要な非秘密の設定、保存先、cloudへ返す確認結果を渡します。既に許可された目的について、作業のたびに包括的な確認を繰り返しません。

既存Botがある場合は、まず対象のprivate設定と実アカウントを照合します。既存tokenのreset、新しいBotの作成、稼働中Webhookの差し替えを初期化のために行いません。既存の個人用Codex設定はlocalに残し、cloud向けにログインファイルや履歴を輸出しません。

### LINE

[LINE標準セットアップ](line-setup.md)に沿って、LINE Business IDと公式アカウントを用意し、[Official Account Manager](https://manager.line.biz/)でMessaging APIを有効にします。[LINE Developers Console](https://developers.line.biz/console/)で対象Provider / channelを開きます。Providerは固定されるため、既存の対象を確認して選びます。

取得する接続情報は対象channelのaccess tokenとchannel secretです。cloud側の安全な受信先が準備できた後、Webhook URLを設定し、VerifyとUse webhook、再送、応答設定を確認します。Node版では実ユーザーが友だち追加して送信する初回ペアリングを確認します。Sites版はコードを発行せず `LINE_ALLOWED_USER_IDS` の本人allowlistを使うため、[Sitesの本人照合手順](../adapters/sites/README.md#verify-the-line-owner-before-enabling-intake)を先に完了し、その後に新規メッセージを送ります。Verifyの成功はAI返信の検証ではありません。[LINE公式の作成手順](https://developers.line.biz/en/docs/messaging-api/getting-started/)

### Discord

[Discord標準セットアップ](discord-setup.md)に沿って、[Developer Portal](https://discord.com/developers/applications)の対象Application / Botを確認します。必要なMessage Content Intentと、Botの実装に合うintent、招待scope・最小限のpermissionを設定します。接続情報はそのBotのtokenです。専用の許可済みDM / serverで初回ペアリングと返信を確認します。[Discord公式のGateway仕様](https://docs.discord.com/developers/events/gateway)

新しいpasswordの設定、OTP / SMS、CAPTCHA、規約など、本人操作・その画面の確認が必要な箇所は使用toolの規則に従いprivate handoffを出します。ユーザーが参加する必要のない設定はagentが続けます。

## 4. 必要なsecretだけを実行環境へ設定する

実際にBotへ接続するcloud runtimeには、そのruntimeで使えるsecretが必要です。local設定が存在することだけでcloudの認証は完了しません。

- 新規セットアップでは、指定したprivate `.env` または対応するcloud secret storeへ直接保存します。値を標準出力やチャットへ返しません。
- localからの移行では、利用者が許可したBot接続に必要な最小限のsecretだけを、環境でサポートされた認証・暗号化済み経路で渡します。安全な経路がなければ、対象secret名とprivate入力先を用意します。
- `.env`全体、browser cookie、Codex login、既存会話DB、他サービスのcredentialは渡しません。cloud側のowner secretもprivateに管理します。
- 新しいOpenAI APIキーの作成を標準手順にしません。`dot`のAI処理はYour dotとMCP Eventsを使います。Secure MCP Tunnelのruntime API keyが必要な場合は別の要件として扱います。

Codex cloud environmentはdirect environment variablesとnetwork secretsを区別しています。network secretはHTTPSの許可宛先でproxyが置換し、programにはplaceholderを渡します。secretの生値を読む必要がある設定やWebSocket接続に、同じ仕組みが使えると推測しません。利用環境の対応を確認します。[Cloud environment secrets](https://learn.chatgpt.com/docs/environments/cloud-environments)

private設定をロードして診断します。以下はrepoルートから実行します。

```bash
node --env-file=data/setup/dot-cloud/.env -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json doctor --probe
```

非表示入力のterminalから対象 `.env` へ保存する場合は、以下で保存先を明示できます。cloud側のterminalへ安全に入力できる場合に使います。localで取得した値をチャットに貼って渡す方法にはしません。

```bash
node -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json channels add --channel line --env-path data/setup/dot-cloud/.env
node -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json channels add --channel discord --env-path data/setup/dot-cloud/.env
```

使うchannelのコマンドだけを実行します。通常の `./bin/codex-line-bridge` はrepoルートの `.env` をロードするため、生成したprivate `.env` が自動選択されると判断しません。`--env-path` は保存先の指定で、Nodeの `--env-file=...` は実行時のロードです。

`doctor` のreadyは設定・API probeの判定です。process継続、Your dotの購読、PC独立性は別途確認します。runtimeを起動する場合も同じ `.env` と設定を使います。

```bash
node --env-file=data/setup/dot-cloud/.env -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json gateway
```

このforegroundコマンド自体は常駐serviceをインストールしません。環境で実際に使えるservice管理・再起動方法を確認して組み込みます。

## 5. Your dotのMCP接続とイベント購読を確認する

[Your dot接続ガイド](dot-integration.md)のOAuthと購読を設定します。LINEなら `line:read` / `line:write`、Discordなら `discord:read` / `discord:write`、新着イベントなら `events:subscribe` を認可します。channelを追加した場合、既存tokenのscopeはmanifest変更だけでは増えないため必要な再認可をします。

**GitHubのpluginをimportしただけではcloud対応になりません。** 公式のworkspace plugin案内では、`mcp.json`等にMCP serverを宣言したimport pluginは、remote HTTPSであってもDesktop onlyです。cloudで使えるcustom MCP connectionやregistered appを実際に作成・接続します。`.app.json`のreferenceは既存appを参照するもので、新しいappを作成したり認可したりする機能ではありません。[Plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)

確認する流れは次です。

1. 接続先へ到達し、OAuthを終えて必要なscopeがある。
2. ツールと `line.message.created` / `discord.message.created` が発見される。
3. 許可済みの本人の会話を指定してYour dotが `events/subscribe` する。
4. signed callback challengeが成功し、購読が保存される。
5. 新規実メッセージがeventとして届けられ、Your dotが読み、同じ会話へreply toolで返す。

以下のペアリングコマンドはNode版向けです。Sites版のallowlistはこのCLIでは更新されません。ペアリングは、実アプリ等で本人の送信と照合できたowner / 許可済みtest senderのコードだけを承認します。未承認の一覧を一括で許可しません。必要な場合は同じruntime設定で次を使います。

```bash
node --env-file=data/setup/dot-cloud/.env -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json pairing list line
node --env-file=data/setup/dot-cloud/.env -- src/cli.mjs --config data/setup/dot-cloud/bridge.config.json pairing approve line <VERIFIED_OWNER_CODE>
```

Discordの場合は `line` を `discord` に変えます。承認後、過去のメッセージを自動再実行せず、本人から新しいメッセージを送って確認します。

event callbackの2xxは受信確認で、後続処理は非同期です。reply toolの完了と実アプリ上の返信到着まで確認します。返信キーを再試行でも維持し、自分の返信で再度応答し続けないことも確認します。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

Secure MCP Tunnelを選ぶ場合、tunnel ID、runtime API key、対象organization / workspace、権限、`tunnel-client`の継続稼働を個別に確認します。MCPへの接続経路であり、LINEの一般Webhook受信先を提供するものではありません。[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 6. 既存稼働からの移行とPC独立性を検証する

既存local Botが動いている場合は、その状態・owned service・未処理queue・LINE endpointを記録します。cloud側の設定と接続を準備し、管理できるtest account等で検証してから切り替えます。同じBot / DBで競合するconsumerを並行稼働させません。

同じ実Botでの検証にはcoordinated cutoverが必要な場合があります。既存処理を完了し、対象が自分のserviceであることを確認してgracefulに停止し、新しいruntime / endpointへ切り替えます。失敗時は新しいconsumerを止めて、記録した旧service / endpointへ戻します。別accountのendpointや無関係なserviceは変更しません。

既存承認を引き継ぐ場合は、移行に必要な確認済み送信者の承認とaccess policyだけを、対応する検証済みの方法で保存します。会話履歴やCodex sessionを含むSQLite全体を移す方法にはしません。承認移行の仕組みが用意されていなければ、その条件を未完了と記録し、本人を確認した再ペアリングで進めます。

成功条件は、次の事実を確認できることです。

- 実LINE / Discordから送った**新しい**メッセージがcloud runtimeへ届く。
- ペアリング後、Your dotが応答して同じ会話に返信が届く。
- runtimeの再起動後も承認・保存済み状態を維持し、新しいメッセージへ返答する。
- local bridge / local資源が利用不能な状態でも、同じ新規メッセージの往復が通る。

許可された移行の範囲でowned local serviceを一時停止する方法なら、PC全体の電源offなしに依存を切り離した試験を行えます。停止するserviceとrollbackを先に確認します。PC全体のshutdown、他taskの停止、広範囲の接続revokeは、その操作の許可なしに実行しません。PCをoffにする試験が必要な場合は、cloud側の準備を終えてから本人へ具体的な最終手順を渡します。

dotのlocal taskは切断時にcloudへ自動移動しません。cloud workが継続することと、既存local gatewayが移行したことを区別します。[Local computer access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access)

## 再開と完了報告

中断したら同じ `setup plan` と保存済み出力先を使い、存在するprivate設定を再利用します。`setup-state.json`にはsecretやチャット本文を追加せず、実施済み手順と未確認の条件を非秘密の形で保持します。setup toolの出力を、実メッセージ検証やcloud稼働の証拠に置き換えません。

報告では **設定準備済み / 接続済み / 実往復済み / 再起動確認済み / local依存なしの実往復済み** を確認できた事実だけで説明します。最後の検証が未実施なら、残る条件と次の具体的な操作を示します。状態が変わらない定期監視やscheduled taskを自動追加しません。

local運用を利用者が選ぶ場合は、次で別の計画を生成できます。

```bash
./bin/codex-line-bridge setup plan --target local --channel both --mode codex
./bin/codex-line-bridge setup prepare --target local --channel both --mode codex
```

これはそのPCの個人用Codex loginを使う構成です。PCのshutdown / sleep / offline中は停止し、cloudへ自動移行しません。ログイン時のservice復帰は、対応するOSのservice管理を設定・検証した場合に限ります。既存稼働設定を使うときは、新しいscaffoldで上書きしません。

DiscordのみでCLIの受信箱を選ぶ場合は、明示的に `--target dot-cloud --channel discord --mode inbox` を指定できます。HTTP公開先とMCP購読を使わず、そのcomputerのCLIで読取・返信します。新着からdotを自動起動する機能はなく、processの継続稼働条件は残ります。
