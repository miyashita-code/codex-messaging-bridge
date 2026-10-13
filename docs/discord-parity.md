# Discord互換範囲と通信契約

確認日: 2026-10-13。OpenClawの公開仕様に合わせ、Discordの公式GatewayとREST APIを独立実装しています。OpenClaw本体を内包するものではありません。セットアップは[Discord接続ガイド](discord-setup.md)に従います。

## 実装した範囲

| 範囲 | このブリッジの動作 |
| --- | --- |
| 受信 | 外向きのWebSocketでDiscord Gateway v10に接続。公開Webhook endpointは不要 |
| 接続維持 | Hello、Heartbeat、ACK監視、DiscordからのHeartbeat要求、Reconnect、Invalid Session、Resumeを処理 |
| Intents | Guilds、Guild Messages、Direct Messagesを使用。Message Contentは標準で有効、Guild Membersは設定で有効化 |
| DMとサーバー | メッセージと送信者・Role・返信・メンション・添付情報を共通受信処理へ渡す |
| スレッド | Guild Create / Thread Create / Update / List Syncから親チャンネルを追跡。会話とアクセス設定はブリッジ本体で適用 |
| 返信 | 2000 UTF-16単位の本文、最大10 embeds、標準ボタンとリンクボタンのAction Row、ネイティブ返信参照 |
| 送信許可 | 全返信で `allowed_mentions: {"parse":[],"replied_user":false}` を強制し、意図しない通知を防ぐ |
| 添付 | 公式Discord添付CDNから取得。リダイレクトを拒否し、HTTP/MIME/サイズを検証。ストリーム上限とatomic保存、ファイルmode `0600` |
| Interactions | Gatewayからコマンド・ボタン操作を受信。RESTによる即時応答、defer、元の応答の更新を提供 |
| コマンド登録 | 明示的な操作で、引数なしのchat input commandsを一括登録。自動接続時に既存command registryを置き換えない |
| エラー | 429の待機時間を呼出元へ返す。4014など認証・Intents・shardの致命的失敗では停止 |

OpenClawに合わせた `channels.discord`、DMのペアリング、サーバーとチャンネルの許可リスト、メンション条件、account分離は[アクセス設定](discord-setup.md#guild-workspace)を参照してください。[OpenClaw Discord仕様](https://docs.openclaw.ai/channels/discord)

## Gateway受信の保存境界

`DiscordGateway` の `onMessage` とinteractionの受付・保存処理は受信順に実行されます。`onInteractionReceived` はACK専用で、受信直後に開始して先行メッセージの処理を待ちません。永続受付が成功してからResume用のsequenceを確定するため、SQLiteへの受付が失敗した場合は未確定メッセージより前の位置からResumeを試みます。HeartbeatにはDiscordが要求する最後の受信sequenceを使用し、Resumeの保存境界とは別に管理します。

`onMessage` は永続キューへの受付だけを行い、AIの完了を待ちません。Interactionの初回応答はDiscordの3秒以内の期限に間に合う必要があります。長い処理を開始する前に受付応答またはdeferを送信します。[Discord Gateway](https://docs.discord.com/developers/events/gateway)、[Discord Interaction応答](https://docs.discord.com/developers/interactions/receiving-and-responding)

Gateway sessionとResume URLはプロセス内のメモリに保持します。プロセス終了後の再起動は新規接続となり、停止中のDiscordメッセージ全件を取得する履歴同期は提供していません。ResumeはDiscordがsessionを保持している間だけ可能です。保存済みキューと返信状態はSQLiteで復旧します。

## Discord送信の重複防止

各送信の呼出元が指定したidempotency keyとメッセージ位置から、25桁以内の安定したdecimal nonceを生成します。送信時は `enforce_nonce: true` を指定します。Transport内では自動再送を行いません。429の `retry_after` は `DiscordError.retryAfterMs` としてキューに渡し、再送時にも同じnonceを使用します。

Discordのnonce重複排除は「直近数分」の範囲です。期限は24時間の永続契約ではなく、通信タイムアウト後の無期限な再送に重複しない保証はありません。ブリッジは送信中状態が古くなった場合や受付済みかつreceipt不明の場合に確認待ちで停止します。SQLiteに記録済みの完了送信は再実行しません。[Discord Create Message](https://docs.discord.com/developers/resources/message#create-message)

## 未移植の機能

OpenClaw本体の全コマンドカタログ、音声会話・通話への追従、音声文字起こし、Discord Activities、Components V2、select menus、polls、ファイルのmultipart送信、reaction/presenceによるAI起動、モデレーション、PluralKit、ACP・サブエージェントのスレッド管理は未対応です。Botが複数shardsを要求する規模になる場合は、この単一shard実装を拡張する必要があります。

外部宛て返信の承認はブリッジ本体の送信者・会話・期限の照合に従います。単に `custom_id` を持つbuttonを送ることは、操作を認可するものではありません。未対応のmessage flagsやprivileged mentionsはTransportの入力検証で拒否します。[Discord Component仕様](https://docs.discord.com/developers/components/reference)

## 開発用契約

```js
const client = new DiscordClient(account, { fetchImpl });
await client.botInfo();
await client.applicationInfo();
await client.channelInfo(channelId);
await client.send(channelId, [{ content: '返信', replyTo: messageId }], deliveryKey);
await client.typing(channelId);
await client.download(attachment, targetPath, maxBytes);
await client.interactionCallback(interactionId, token, { type: 5, data: { flags: 64 } });
await client.editInteractionResponse(applicationId, token, { content: '完了' });
await client.registerCommands(applicationId, commands, optionalGuildId);

const gateway = new DiscordGateway(account, {
  onMessage: async (message) => { /* 永続キューへ受付 */ },
  onInteractionReceived: async (interaction) => { /* ACK/deferだけを即時実行 */ },
  onInteraction: async (interaction) => { /* 許可確認と永続受付 */ },
});
await gateway.start();
gateway.status();
await gateway.close();
```

`send` 成功時は `accepted / sentMessages / messageIds / receiptComplete` を返します。失敗時の `DiscordError` は `status / retryable / uncertain / accepted / retryAfterMs` と、それまでに受け取った部分送信のreceiptを返します。ErrorにはToken、Interaction Token、リクエスト本文、HTTP応答本文を含めません。
