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

同じイベントについて、次の3段階を分けて計測します。

1. LINE Webhookの受信・保存から、MCP callbackの `2xx` まで。
2. callback受理から、dotの返信処理開始まで。最初の読取tool呼び出しは、観測できる開始の目安です。
3. 返信処理開始から、LINE API送信完了と実アプリへの到着まで。

dotのtask詳細設定にあるモデル・思考量は、生成時間と品質の調整に使います。通知後の起動待ち時間を保証する設定ではありません。設定変更だけで改善したと判断せず、新しい実メッセージで3段階を再計測します。[モデルと思考量](https://learn.chatgpt.com/docs/models)

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

`backend: "codex"` は、このMacの既存Codexログインでローカルapp-serverを起動する個人用の代替経路です。Your dot自体へメッセージを送る経路ではなく、Your dotの記憶やクラウド常駐機能とは別です。Codex app-server認証を商用・ホスト型サービスに使うことは公式に許可されていません。提供するサービスでは標準のYour dot + MCP Events経路を使い、ローカルCodex代替を商用認証として扱わないでください。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

この実装の自動テストは署名、challenge、購読の永続化、期限、解除、アクセス撤回、返答の宛先制限、再配信を確認します。LINE・DiscordとmacOSの個人用Codexとの実往復は確認済みです。別途構成した所有者限定SiteのMCP入口ではOAuth接続・状態取得を確認し、Your dot側も実呼び出し成功を報告しています。Sites版では2026-10-15に実購読とYour dotのLINE / Discordメンションへの自動返信をローカル受信停止中に確認しました。Node版のcloud daemon常駐は未検証です。[READMEの検証範囲](../README.md#実装範囲検証)を参照してください。
