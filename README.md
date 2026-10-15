# Codex LINE / Discord Bridge

LINE・Discordから、Your dotまたは自分のCodexをAI秘書として使うためのブリッジです。OpenClawと同じ設定名・Botセットアップの流れ・ペアリング形式に合わせています。MITライセンスで、各自のBotとアカウントを接続して使えます。

An open-source LINE / Discord bridge for Your dot and personal Codex. It follows OpenClaw-style channel settings, setup and pairing. Use your own bot, credentials and data directory. See the [English quickstart](#english-quickstart).

## dotにセットアップを任せる

このrepoのURLと、次の依頼をYour dotへ渡します。エージェントの入口は [AGENTS.md](AGENTS.md) です。

> このrepoのAGENTS.mdに従って、LINEとDiscordを私のdotにつないで。cloud computerを主な稼働先にし、ログインやBotのアカウント設定は接続済みの私のPCで進めて。接続コードは期限なしにして。既存の設定を引き継ぎ、実際の送受信とPCに依存しない動作まで確認して。

dotはcloudで動作条件を確認し、専用の非公開設定を準備します。ログイン済みブラウザやアカウント作成が必要な工程は、接続済みPCのツールで進めます。途中で本人の認証操作が必要になっても、進捗を保存して続きから再開できます。[セットアップの流れ](docs/agent-onboarding.md)

```bash
./bin/codex-line-bridge setup plan --target dot-cloud --channel both
./bin/codex-line-bridge setup prepare --target dot-cloud --channel both
```

`prepare` は `data/setup/dot-cloud/` に専用設定と進捗を作り、既存のBot設定を上書きしません。新規セットアップのペアリングコードは期限なしです。cloudの常駐・LINE用の安定したHTTPS・dotの実接続は別途確認します。これらが利用できない場合は不足条件を保存し、Mac上の動作をcloud移行完了として扱いません。

## Sitesクラウド版

[Sites adapter](adapters/sites/README.md) は、LINEの公開受信・MCP Events・Discordのクラウド回収と再試行をWorker/D1で実装します。追加のhosting契約やOpenAI APIキーを使わず、既存のYour dotを接続するための構成です。2026-10-15に、MacのLINE / Discord受信サービスを停止した状態で、実LINEメッセージと実DiscordメンションからYour dotが自動返信することを確認しました。LINEは公開Webhookで直接受信し、Discordはdotのcloud browserから15秒ごとに回収します。受信タブが閉じた場合の回収・再試行用クラウドスケジュールは保存済みで、タブ停止後にも新規LINEへの自動返信を確認しましたが、通知後のdot処理に約10分かかった例があります。スケジュールの停止後復旧は検証を継続しています。試験アカウントでは毎時実行が上限でした。復旧の実測と制約は[クラウド移行記録](docs/cloud-computer.md#sitesでの移行検証2026年10月15日)を参照してください。各利用者のSites利用権限・接続・購読を個別に確認します。

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

ペアリングは初回接続の承認です。承認済みの接続は、明示的に取り消すまで保存されます。承認待ちコードの期限をなくす場合は、LINE / Discordの `pairingCodeTtlMs` を `null` にします。省略時の1時間は承認待ちコードの有効時間です。任意の正の整数を指定すると、そのミリ秒数だけ有効になります。設定方法は[LINE](docs/line-setup.md#access-control)・[Discord](docs/discord-setup.md#guild-workspace)の案内を参照してください。

```bash
./bin/codex-line-bridge gateway status
./bin/codex-line-bridge channels status --probe
./bin/codex-line-bridge queue list
./bin/codex-line-bridge pairing revoke discord default <USER_ID>
```

macOS LaunchAgent、Linux systemd、Caddyの例を `deploy/` に同梱しています。データは既定で `data/`、保存期間は30日、受信キュー上限は10000件です。バックアップはプロセス停止後、SQLite本体と関連ファイルを一緒に保存します。

ローカルで動かす場合、電源オフやスリープ中は返信できません。LaunchAgentはユーザーログイン後、systemdは設定した起動条件で復帰します。承認と会話履歴はDBに残ります。dotにrepoを渡しても、既存のローカルGatewayが自動でcloudへ移るわけではありません。PCが使えない状態でも新規メッセージへの返信が成功したことを確認して、PCから独立した運用と判定します。

## 実装範囲・検証

署名検証、Gateway再接続、会話ごとの順序、重複排除、再試行、DMペアリング、グループ許可、メディア取得、返信の分割、送信の冪等性、OAuth / PKCE、MCP Eventsを実装しています。個人用Codexは会話を継続し、承認要求を依頼者へ返します。既定のsandboxは `read-only` です。

OpenClawの全機能を再現する実装ではありません。対応範囲と差分は[LINE互換仕様](docs/openclaw-parity.md)・[Discord互換仕様](docs/discord-parity.md)を参照してください。添付の内容分析は接続先のAIとツールに従います。利用者別のOS隔離やマルチテナントSaaSは含みません。

```bash
npm test
npm run check
CODEX_SMOKE=1 node --test --test-name-pattern='real CLI smoke' tests/codex.test.mjs
CODEX_E2E=1 npm run test:codex-e2e
```

通常のテストはサービス認証情報を使わず、モックのLINE / Discord / MCP経路を検証します。`CODEX_SMOKE` はCodexログイン接続のみ、`CODEX_E2E` は自分のログインで実際に2回推論し、ペアリング・重複抑止・再起動後の会話再開まで検査します。E2EのDiscord通信は模擬で、一時的なブリッジデータは削除します。Codex側には検査用の会話が残ります。実Bot・Your dotとの往復、cloud computerの継続稼働はそれぞれの実環境で確認します。Node.js 22 / 24 / 26で検査するGitHub Actions設定例は `deploy/github-actions-ci.yml.example` にあります。利用する場合は `.github/workflows/ci.yml` にコピーします。このリポジトリでは、現在のGitHub CLI認証にworkflow書き込み権限がないためCIを有効化していません。

2026-10-13にmacOSで実Discord Botと既存Codexログインを接続し、サーバーのメンションからのAI返信、DMの初回ペアリングと承認後のAI返信、プロセス再起動後の同一会話の継続を確認しました。LaunchAgentでの常駐運転へ切り替えた後も実返信を確認しています。

2026-10-14には実LINE Botで初回ペアリングを承認し、本人のLINE入力からCodexの実推論を経て、同じLINE会話へ「LINE実機E2E成功」が届くことを確認しました。期限なしの設定を反映するGateway再起動後も承認済み接続と会話を維持し、前の会話で伝えた内容を再入力せずに返答できることを確認しています。LINEの受信には公開HTTPS Webhookを使用しています。これらはmacOSの個人用Codex経路の実通信検証です。別途構成した所有者限定SiteのMCP入口はOAuth接続・状態取得を確認し、Your dot側も実呼び出し成功を報告しています。2026-10-15にはSites版で、ローカル受信サービスを停止した状態のLINE / Discordメンション → Your dot → 同じ会話への返信も成功しました。これは物理的なPC電源断や24時間連続運転の試験とは区別します。[クラウド移行の実測](docs/cloud-computer.md#cloudでの試験結果と残る確認)を参照してください。通常テストは181件成功・1件スキップです。repo引き渡し用セットアップも隔離環境で検証しています。[変更履歴](CHANGELOG.md)

持ち込み用アーカイブは `npm run package:cloud` で `data/codex-messaging-bridge-cloud.tar.gz` に生成します。実 `.env`、ローカル設定、認証情報、稼働中DBを含めません。

## English quickstart

To let your dot handle setup, give it this repository and ask: “Follow AGENTS.md to connect LINE and Discord to my dot. Prepare the cloud runtime, use my connected computer for account setup, preserve existing settings, and verify actual replies without depending on my laptop.” The [agent onboarding guide](docs/agent-onboarding.md) covers resumable setup and the capability checks needed before claiming cloud operation.

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

Approved connections remain stored until explicitly revoked. Set the channel or account's `pairingCodeTtlMs` to `null` for pending pairing codes without expiry, or to a positive integer duration in milliseconds. The omitted one-hour default applies to unapproved codes.

Discord Gateway needs an active process but no public webhook or domain. For **Your dot without a public endpoint**, keep `backend: "inbox"`; your dot reads and replies through the CLI on the same computer. This inbox mode does not wake your dot when a message arrives. For **Your dot MCP Events**, use `backend: "dot"`, an HTTPS MCP endpoint, OAuth and event subscriptions. LINE always needs an HTTPS webhook receiver. Continuous operation on your dot's cloud computer has not been verified.

Live Discord and LINE exchanges with personal Codex on macOS have passed. Discord testing includes mentions, DM pairing and replies, and conversation continuity after switching to LaunchAgent. LINE testing includes pairing, an actual user message through Codex to a reply in the same conversation, and retention of approval and conversation context after restarting the gateway with no-expiry codes configured. On 2026-10-15, the Sites adapter also passed real LINE and Discord mention → Your dot → same-conversation reply tests with both local receivers stopped. This is distinct from a physical laptop power-off or 24-hour uptime test. Discord fast polling uses the dot cloud browser; scheduled recovery is subject to the account’s cadence limit (hourly in the tested account). See the [changelog](CHANGELOG.md).

See the [installation and profile guide](docs/install.md#english-installation-guide), [Discord setup](docs/discord-setup.md), [LINE setup](docs/line-setup.md) and [Your dot integration](docs/dot-integration.md). Each user supplies their own credentials. Local Codex app-server login is for local / open-source use, subject to [OpenAI's authentication conditions](https://learn.chatgpt.com/docs/app-server).

## License / References

[MIT](LICENSE). This is an independent project; it is not an official OpenAI, LINE, Discord or OpenClaw integration.

- [OpenClaw LINE](https://docs.openclaw.ai/channels/line) / [Discord](https://docs.openclaw.ai/channels/discord/setup)
- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Connect a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Your dot computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
