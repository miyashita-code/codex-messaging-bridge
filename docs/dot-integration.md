# Your dot と LINE / Discord の接続

repoをdotへ渡してセットアップを任せる場合は、[AGENTS.md](../AGENTS.md) と [エージェント用セットアップ](agent-onboarding.md) から始めます。cloudの準備と接続済みPCでのアカウント設定を分け、既存のローカルBotを維持しながら切り替えを検証します。

Discordも同じMCP endpointで使えます。イベントは `discord.message.created`、ツールは `discord_list_conversations`、`discord_list_inbox`、`discord_read_message`、`discord_read_media`、`discord_reply` です。DiscordのBot設定とペアリングは[Discord標準セットアップ](discord-setup.md)に従います。LINEとDiscordの購読・配信は別々に保持します。

公開サーバーを用意しないDiscord構成は `bridge.discord.cloud.example.json` の `backend: "inbox"` / `transport: "headless"` です。これはMCPイベント購読を使わず、Your dotが同じcomputerのCLIで受信箱を読み、返信します。新着で自動起動する経路とは別です。[Cloud computerでの運用](cloud-computer.md)

このブリッジの標準バックエンドは `dot` です。LINEの受信を公式のMCP EventsとしてYour dotに届け、Your dotが `line_reply` を呼ぶことでLINEへ返答します。LINEがYour dotの「Add」に新しい純正連絡方法として表示される実装ではありません。

公式の[MCP Events](https://developers.openai.com/plugins/build/mcp-events)はdotsに対応しています。MCP 2.0 `2026-07-28` のイベント購読後、ChatGPTが指定した署名付きWebhookへ配信し、購読先の会話で設定済みの処理を実行する仕組みです。この経路を使うため、OpenAI APIキーやCodexのログイントークンをブリッジへ渡す必要はありません。接続には利用者のChatGPTアカウント、Your dot、カスタムMCP接続が使える権限が必要です。

## Sites版の接続

追加hosting契約なしでSitesを使う場合は、[adapterの配備手順](../adapters/sites/README.md)に従います。以下のNode版OAuthサーバーとは別の実装で、認証はSites-created pluginの本人接続を使います。実際に発見されたツールとイベントschemaを優先します。

| Sitesイベント | 購読フィルター | 読取 → 同じ会話への返信 |
| --- | --- | --- |
| `line.message.created` | `{}`。サーバー側の確認済み送信者allowlistを適用 | `line_message_read({event_id})` → `line_reply({event_id, content})` |
| `discord.dm.message.created` | 設定済み `guild_id` と本人DMの `channel_ids` | `discord_dm_message_read({channel_id, message_id})` → `discord_reply_dm({channel_id, message_id, content})` |
| `discord.message.created` | 設定済み `guild_id`、`channel_ids`、`mentions_only: true` | `discord_message_read({channel_id, message_id})` → `discord_reply_to_mention({channel_id, message_id, content})` |

返信先は元メッセージへ固定され、永続化した返信キーで重複を抑止します。本人からのイベント本文を読んでdot自身が応答し、無関係な会話の非公開情報を混ぜないよう指示します。カタログ更新後はpluginを再スキャンし、購読・challenge・実返信を確認します。`bridge_maintain({})` は回収・未配信再試行・期限付きLINE tokenの更新を行い、モデル推論は実行しません。

通知を受理した後に返信処理が始まらない場合に備え、Sites版には `line_inbox_read({limit:20, cursor?})` もあります。現在承認済みの1対1LINEのうち、返信actionがまだ存在しないevent_idと時刻だけを返します。復旧taskは毎回cursorなしから始め、`next_cursor` があれば空ページでも続け、`line_message_read` で読み取ってから同じevent_idへ返信します。イベントtaskと同じ送信予約を使うため、並行実行でも重複送信を抑止します。予約済み・再試行中・結果不明・失敗・完了のactionがある入力は対象外で、結果不明の送信は再送しません。通常イベントによるdot返信と復旧taskによる返信は、検証記録でも区別します。

2026-10-15にSites版の実LINE / Discordメンションへの自動返信を、Mac受信サービス停止中に確認しました。Node版のcloud常駐検証へ読み替えず、利用者ごとに同じ試験を行います。

### 返信までの待ち時間を切り分ける

callbackの `2xx` は通知の受付であり、dotの返信処理開始の証明ではありません。処理は非同期で、通知が速く届いても開始まで数分待つ場合があり、即時応答は保証しません。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

同じイベントについて、次の段階を分けて計測します。

1. LINE / Discordのplatform event timestampからクラウド保存まで。LINEのWebhook到達前とDiscordのREST回収待ちを含みます。
2. LINE Webhookの受信・保存から、MCP callbackの `2xx` まで。
3. callback受理から、dotの返信処理開始まで。最初の読取tool呼び出しは、観測できる開始の目安です。
4. 返信処理開始から、LINE API送信完了と実アプリへの到着まで。

dotのtask詳細設定にあるモデル・思考量は、生成時間と品質の調整に使います。通知後の起動待ち時間を保証する設定ではありません。設定変更だけで改善したと判断せず、新しい実メッセージで各段階を再計測します。[モデルと思考量](https://learn.chatgpt.com/docs/models)

Sites版のowner用 `bridge_status.delivery_diagnostics` は、直近の許可済みイベントについてplatform発生、受信・保存、callback配信記録、最初の読取tool到達、返信予約、送信試行、送信完了の時刻を返します。読取未到達は `null` のまま表示し、本文・secret・callback URLは含めません。診断は直近7日・最大10件で、現在の送信者・会話ポリシーを再確認します。

`source_occurred_at` はplatformのイベント発生時刻で、入力を考え始めた時刻やモデル開始ではありません。`interval_ms.occurred_to_recorded` で保存までの時間を分け、欠損・不正な発生時刻は `null` とします。`first_read_tool_at` は成功した読取toolへ入ったサーバー時刻で、モデル起動時刻ではありません。手動の読取も観測されるため、E2Eの新着をこちらから読まず、dotの実行履歴と照合します。`confirmed_completed_at` は送信API成功後の時刻で、端末への表示は実アプリで確認します。未観測・負の時間差・診断取得失敗を、遅延ゼロや成功に読み替えません。

### First-party cloud taskで待機・返信する実験経路

dotのイベント起動待ちを通さず、既存のfirst-party cloud taskがMCPで新着を待ち、本文を読んで返答を生成する経路も実装しています。実環境では既存のnative cloud Work復旧taskを再利用しています。これはNode版の `backend: "codex"` をcloudへ移す操作ではなく、CodexのログインファイルやAPIキーを渡す必要はありません。CLIの `--target dot-cloud --mode codex` は引き続き拒否します。cloud Work task、一時background agent、Codex Cloud taskは実際の実行環境を確認して区別し、cloud taskが返答しただけで「Your dot本人」や「Cloud Codex」の実返信とは記録しません。[Cloudのtask](https://learn.chatgpt.com/docs/dots/tasks-and-memory)、[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)

利用者がこの返信runtimeを選んだ場合だけ、Sitesの本人接続から次の2ツールを使います。Workerはモデルを呼ばず、受信・認可・claim・送信だけを担当します。実LINE / Discord返信とlocal cloud-chat panelを閉じた後の継続を確認しました。**無期限の待機と停止後の自動復旧は未検証です。** 先に確認したMCP Events経由のdot返信や、ローカルCodexの実績とは分けて評価します。

| ツール | 動作 |
| --- | --- |
| `bridge_wait_for_message({wait_ms:25000, lease_id?})` | 最大25秒待機し、120秒のconsumer leaseを取得・更新して、現在許可された未返信メッセージを1件claim。返された `lease_id` を次の待機にも使う |
| `bridge_reply_to_claim({lease_id, claim_id, content})` | 現在の認可を再確認し、claimした元の会話へ既存の重複抑止付き送信処理で1回返信。任意の宛先やsource IDは指定できない |

有効化にはSites runtime設定の `CLOUD_AGENT_ENABLED=true` と、協調切替時刻のISO timestamp `CLOUD_AGENT_AFTER` が必要です。設定を揃えて配備し、実際のcloud taskでツール発見・本人認証・ `bridge_status.cloud_agent` を確認します。activation watermarkより前の入力や、既に返信actionが存在する入力を再送対象にしません。保存済みwatermarkは後ろへ戻らず、環境設定のrollbackで過去入力を再開しません。claim・送信記録を削除して未処理に見せる操作もしません。

新しいconsumerは1つだけにします。既存dot側の返信イベント購読とtask指示を記録し、進行中の処理を完了してから、所有する返信consumerだけをpause・購読解除します。チャネルの `LINE_ENABLE_EVENTS` / `DISCORD_ENABLE_EVENTS` は新着取込にも使うため、購読解除の代わりに無効化しません。本人・送信者allowlist・会話制限は維持し、新たな定期jobや権限を追加せず、既存の復旧taskを再利用します。毎時fallbackを設定・実行できることは、即レスや常駐の証拠にはなりません。

同じ会話の確定済み入力・返信を暗号化して最大6往復/12メッセージ/24,000文字保存し、次のwaitの `conversation_context` へ渡します。owner・Bot・チャネル種別・会話の境界を保ち、Your dot本人の記憶とは区別します。モデルは返された同会話履歴だけを使い、運用chatや別会話の事実を混ぜません。30日より古い履歴は読取対象外、暗号文の削除は次の成功write時のlazy cleanupです。`context_recorded:false` でも完了済み送信は再送しません。

wait中のDiscord回収は既存cursor・収集lease・認可・429 cooldownを共有し、GETによる取込と永続化だけを行います。LINE token更新・LINE再送・callback drainは行いません。有効化中の `/runtime/tick` はstandbyを返し、残存browser tabからも回収・送信しません。受信本文を信頼済みの指示として扱わず、会話ごとの非公開contextを分け、空・busy・lease喪失時に勝手な送信やconsumerの奪取をしないようtaskへ指示します。送信結果不明・失敗・予約済みの入力は再送せず、確認待ちとして残します。

配備後はMacのowned受信を使えない状態とbrowser standbyを確認し、新しい実LINE / Discord入力から同じ会話への返信までを、手動の追いかけ指示なしで計測します。task中断、leaseの失効・再取得、復旧も別途検証します。失敗時は新consumerを止め、flagを無効にして再配備し、記録した既存購読と1つのcloud受信経路へ戻します。watermark・claim・送信記録・secretは保持します。詳細は[adapterの実験手順](../adapters/sites/README.md#first-party-cloud-task-receiver-experimental)を参照してください。

## Node版の接続の流れ

1. READMEの手順でLINEチャネル、HTTPS公開URL、管理者接続パスフレーズを設定し、`backend: "dot"` でブリッジを起動します。HTTPSリバースプロキシから `/mcp`、`/.well-known/`、`/oauth/`、LINE Webhookの各パスを転送します。
2. LINE Botにメッセージを送り、CLIでペアリングを承認します。グループはグループと送信者の許可設定も行います。`line_list_conversations` は受信済みで許可された会話だけを返します。
3. ChatGPTのPluginsから「Add custom MCP server」を選び、`https://あなたの公開ドメイン/mcp` を登録します。OAuth接続にし、ブリッジの管理者接続パスフレーズで認可します。認証メタデータ、動的クライアント登録、PKCE、token endpointはブリッジに同梱されています。
4. MCPツールと `line.message.created` イベントが発見されることを確認します。Your dotで下の指示を送り、購読が作成されたことを確認します。
5. LINEから別のメッセージを送り、Your dotの処理とLINEへの返答を実機で確認します。接続許可、アカウントやワークスペースの機能制限により、利用可能な機能は変わります。

カスタムMCP登録とメタデータ更新の公式手順は[Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)、認証の要件は[Authentication](https://developers.openai.com/plugins/build/auth)を参照してください。

## Your dotへ送る設定指示

```text
LINE AI秘書プラグインを使って、許可済みのLINE会話を一覧してください。
私のLINE会話について、line.message.created イベントを購読してください。
account_id と conversation_id は一覧の値を使ってください。

新しいメッセージが届いたら、その message_id を line_read_message で読み、
私からの依頼を、接続済みアプリの既存権限の範囲で進めてください。
返答や、私の判断が必要な質問は同じLINE会話に line_reply で送ってください。
返信には、その返信用の安定した idempotency_key を使い、再試行でも同じキーを使ってください。
別の会話の非公開情報を、その会話の相手へ共有する許可にはしないでください。
LINEで受けた依頼から、必要に応じて通常のCodexタスクへ作業を委譲してください。
購読を作成できたかと、対象の会話を教えてください。
```

複数のLINE会話は別々に購読します。グループで送信者を絞る場合は `user_id` も指定します。`events/subscribe` はJSON-RPCのプロトコルメソッドで、モデル向けのMCPツール一覧には入れません。

## 実装されているMCP契約

| メソッド・ツール | 動作 |
| --- | --- |
| `server/discover` | `2026-07-28` とtools/events capabilitiesを公開 |
| `initialize` | 従来のMCPクライアント向け初期化 |
| `events/list` | LINE新着メッセージのイベントとフィルターを公開 |
| `events/subscribe` | 許可済みの既知会話を購読、署名付きchallengeでcallbackを検証 |
| `events/unsubscribe` | 購読と未配信キューを停止 |
| `line_list_conversations` | 現在許可されている既知会話を取得 |
| `line_list_inbox` | 過去の受信を明示的に取得 |
| `line_read_message` / `line_read_media` | 許可済みメッセージと添付を取得 |
| `line_reply` | 既存の許可済みmessage_idの会話に、冪等キーを使って返答 |

新着イベントはSQLiteへ永続化します。同じイベントの再配信では同じevent IDと本文を使い、署名時刻を更新します。期限切れ・解除済みの購読と、LINEへのアクセスを撤回された送信者には配信しません。callbackはHTTPS・公開アドレスに限定し、接続ごとにDNSを検証して検証済みIPへ接続します。リダイレクトを追いません。`mcp.callbackHosts` を設定すると、callbackホストをさらに制限できます。

Webhookは最大8回まで指数バックオフで再試行し、`410` と `413` は再試行しません。`410` では購読を停止します。購読期限は既定24時間、最大7日です。`ttlMs: null` でも無期限購読を付与せず有限の `refreshBefore` を返します。secret更新時は短い移行期間に旧・新の両方で署名します。

**過去イベントのプロトコル再生はありません。** `cursor: null` を返し、購読開始より前の受信は配信しません。購読有効期間中にキューへ保存された未配信イベントはプロセス再起動後に再試行します。購読の失効・解除中に届いたメッセージは `line_list_inbox` で確認してください。`2xx` はWebhook受信の確認であり、Your dotの作業完了やLINEへの返信到着は個別に確認します。

## 配布用プラグイン

`plugin/plugin.json` は現在のportable Agent Plugins形式です。`plugin/mcp.json.example` のドメインを実際のHTTPS URLへ置き換え、`plugin/mcp.json` として保存してから配布します。認証情報をmanifestへ書きません。Your dot向けのオンボーディングスキルを同梱しています。

**GitHubからpluginをimportすることと、cloudで使えるMCP接続を作ることは別の工程です。** 公式のworkspace importでは、`mcp.json` / `.mcp.json` にMCP serverを宣言したpluginは、接続先がremote HTTPSでもDesktop onlyとされています。cloudで使う接続は利用可能なcustom MCP /登録済みappの経路で実際に追加・認証し、dotからツールとイベントを利用できることを確認します。既存appへの `.app.json` 参照だけではappの作成や権限付与は行われません。[Plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)

この設定例のOAuth `baseScopes` は、LINEの閲覧・返信に `line:read` / `line:write`、Discordの閲覧・返信に `discord:read` / `discord:write`、両方の新着購読に `events:subscribe` を要求します。LINEだけ、またはDiscordだけで配布する場合は、使わないチャネルの2つのscopeを外せます。LINE用scopeだけで接続済みの利用者がDiscordを追加するときは、manifestを更新して再接続・再認可し、Discordの権限も与えます。既存access tokenやrefresh tokenには、設定例の変更だけでは新しいscopeが追加されません。

公開提出は安定した公開HTTPS endpointで行います。URLを差し替えただけで公開プラグイン審査済みにはなりません。利用者ごとに、このブリッジの独立インスタンス・LINEチャネル・OAuth認可・データ保存領域を用意する構成です。マルチテナントのSaaSや課金・顧客管理は含みません。公式の[Package your plugin](https://developers.openai.com/plugins/build/plugins)を参照してください。

## 個人用Codexバックエンドとの違い

`backend: "codex"` は、このMacの既存Codexログインでローカルapp-serverを起動する個人用の代替経路です。Your dot自体へメッセージを送る経路ではなく、Your dotの記憶やクラウド常駐機能とは別です。Codex app-server認証を商用・ホスト型サービスに使うことは公式に許可されていません。標準のYour dot + MCP Events経路や、上記のfirst-party cloud task実験経路と区別し、ローカルCodex代替の認証をcloudへ輸出したり、商用認証として扱ったりしないでください。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

この実装の自動テストは署名、challenge、購読の永続化、期限、解除、アクセス撤回、返答の宛先制限、再配信を確認します。LINE・DiscordとmacOSの個人用Codexとの実往復は確認済みです。別途構成した所有者限定SiteのMCP入口ではOAuth接続・状態取得を確認し、Your dot側も実呼び出し成功を報告しています。Sites版では2026-10-15に実購読とYour dotのLINE / Discordメンションへの自動返信をローカル受信停止中に確認しました。Node版のcloud daemon常駐は未検証です。[READMEの検証範囲](../README.md#実装範囲検証)を参照してください。
