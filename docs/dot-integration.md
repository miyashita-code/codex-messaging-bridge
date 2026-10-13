# Your dot と LINE の接続

Discordも同じMCP endpointで使えます。イベントは `discord.message.created`、ツールは `discord_list_conversations`、`discord_list_inbox`、`discord_read_message`、`discord_read_media`、`discord_reply` です。DiscordのBot設定とペアリングは[Discord標準セットアップ](discord-setup.md)に従います。LINEとDiscordの購読・配信は別々に保持します。

公開サーバーを用意しないDiscord構成は `bridge.discord.cloud.example.json` の `backend: "inbox"` / `transport: "headless"` です。これはMCPイベント購読を使わず、Your dotが同じcomputerのCLIで受信箱を読み、返信します。新着で自動起動する経路とは別です。[Cloud computerでの運用](cloud-computer.md)

このブリッジの標準バックエンドは `dot` です。LINEの受信を公式のMCP EventsとしてYour dotに届け、Your dotが `line_reply` を呼ぶことでLINEへ返答します。LINEがYour dotの「Add」に新しい純正連絡方法として表示される実装ではありません。

公式の[MCP Events](https://developers.openai.com/plugins/build/mcp-events)はdotsに対応しています。MCP 2.0 `2026-07-28` のイベント購読後、ChatGPTが指定した署名付きWebhookへ配信し、購読先の会話で設定済みの処理を実行する仕組みです。この経路を使うため、OpenAI APIキーやCodexのログイントークンをブリッジへ渡す必要はありません。接続には利用者のChatGPTアカウント、Your dot、カスタムMCP接続が使える権限が必要です。

## 接続の流れ

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

公開提出は安定した公開HTTPS endpointで行います。URLを差し替えただけで公開プラグイン審査済みにはなりません。利用者ごとに、このブリッジの独立インスタンス・LINEチャネル・OAuth認可・データ保存領域を用意する構成です。マルチテナントのSaaSや課金・顧客管理は含みません。公式の[Package your plugin](https://developers.openai.com/plugins/build/plugins)を参照してください。

## 個人用Codexバックエンドとの違い

`backend: "codex"` は、このMacの既存Codexログインでローカルapp-serverを起動する個人用の代替経路です。Your dot自体へメッセージを送る経路ではなく、Your dotの記憶やクラウド常駐機能とは別です。Codex app-server認証を商用・ホスト型サービスに使うことは公式に許可されていません。提供するサービスでは標準のYour dot + MCP Events経路を使い、ローカルCodex代替を商用認証として扱わないでください。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

この実装の自動テストは署名、challenge、購読の永続化、期限、解除、アクセス撤回、返答の宛先制限、再配信を確認します。LINEチャネルの実認証情報と実際のYour dot購読が未設定の状態では、LINEとYour dotを通した実通信は検証できません。
