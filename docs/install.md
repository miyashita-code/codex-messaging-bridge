# Install / 構成別セットアップ

Node.js **22.13以上**、npm、Gitを用意します。以下はmacOS / Linux / WSLなどのPOSIXシェル用です。利用者ごとに自分のBot認証情報・CodexまたはYour dotアカウント・保存領域を使います。

```bash
git clone https://github.com/miyashita-code/codex-messaging-bridge.git
cd codex-messaging-bridge
npm ci --ignore-scripts
```

`./bin/codex-line-bridge` はチェックアウト内のCLIです。コマンド名はLINE / Discord共通です。例の `<CODE>`、`<MESSAGE_ID>` などは実際の値に置き換えます。既存の `bridge.config.json` / `.env` がある場合は上書きせず、その設定を編集します。

## Discord + 個人用Codex

この構成は外向きのDiscord Gateway接続で受信し、同じコンピューターのCodexが自動返答します。公開HTTPポート、MCP endpoint、OpenAI APIキーは使いません。

```bash
cp bridge.discord.cloud.example.json bridge.config.json
node --input-type=module -e 'import fs from "node:fs"; const p="bridge.config.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.backend="codex"; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n",{mode:0o600});'
```

[公式手順](https://learn.chatgpt.com/docs/codex/cli)でCodex CLIを導入します。既存の自分のChatGPTログインを使うか、端末でサインインします。

```bash
codex login
codex login status
```

[Discord標準セットアップ](discord-setup.md)に従いApplication / Bot、Message Content Intent、招待、DMを設定します。Tokenは非表示の端末入力で `.env` に保存します。

```bash
./bin/codex-line-bridge channels add --channel discord
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

最初のDMに届いたペアリングコードを別の端末で承認し、もう一度DMを送って返答を確認します。

```bash
./bin/codex-line-bridge pairing list discord
./bin/codex-line-bridge pairing approve discord <CODE>
```

Codexの既定の作業場所は `data/workspace`、sandboxは `read-only`、承認は `on-request` です。設定の `codex.cwd` は設定ファイルの場所を基準に解決します。ログインはホストのCodexが管理します。複数の利用者を許可すると、そのホストのCodexを共有することになります。

この既存ログイン経路はローカル・オープンソース用途向けで、商用・ホスト型サービス用の認証ではありません。[App Serverの認証条件](https://learn.chatgpt.com/docs/app-server)

## Discord + Your dot受信箱

公開MCP endpointを用意せず、Your dotが同じcomputerでCLIを操作する構成です。cloud computerへ持ち込む場合も、Nodeの実行とプロセスの継続稼働をその環境で確認します。新着イベントによるYour dotの自動起動はありません。

```bash
cp bridge.discord.cloud.example.json bridge.config.json
./bin/codex-line-bridge cloud-check --probe
./bin/codex-line-bridge channels add --channel discord
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

DMを送り、別の端末でペアリングを承認します。

```bash
./bin/codex-line-bridge pairing list discord
./bin/codex-line-bridge pairing approve discord <CODE>
```

再度DMを送り、同じ保存領域を使うCLIで読み取ります。

```bash
./bin/codex-line-bridge inbox list --channel discord
./bin/codex-line-bridge inbox read <MESSAGE_ID>
./bin/codex-line-bridge inbox reply <MESSAGE_ID> --text "こんにちは" --idempotency-key <REPLY_KEY>
```

`REPLY_KEY` は返信ごとの安定したキーです。同じ返信の再試行には同じキー、別の返信には新しいキーを使います。長い返信には `--text-file answer.txt` も使えます。[Cloud computerの条件](cloud-computer.md)

## LINE / Discord + Your dot MCP

この構成はMCP Eventsの購読を使います。ブリッジへ到達するHTTPS MCP endpointとOAuth接続が必要です。LINEを使う場合は同じホストでLINE Webhookも受けます。

```bash
./bin/codex-line-bridge init
```

`init` はLINE + Your dotの `bridge.config.json` と `.env` を作り、OAuth管理者パスフレーズを生成します。`.env` の `LINE_BRIDGE_PUBLIC_URL` に公開HTTPS originを設定します。`/mcp` や `/line/webhook` はこの値に含めません。

```dotenv
LINE_BRIDGE_PUBLIC_URL=https://gateway.example.com
```

LINEは以下の案内と[LINE標準セットアップ](line-setup.md)に従います。

```bash
./bin/codex-line-bridge channels add --channel line
```

Discordも使う場合は `channels add --channel discord` を実行します。Discordだけの場合は `channels.line.enabled` を `false` にします。`backend` は `dot`、`transport` は `http` のままです。

HTTPSプロキシを用意し、`/mcp`、`/oauth/`、`/.well-known/`、LINEのWebhookパスをブリッジへ転送します。`deploy/Caddyfile` を参考にできます。

```bash
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

BotのDMペアリングを承認後、[Your dot接続ガイド](dot-integration.md)でChatGPTから `https://gateway.example.com/mcp` をOAuth接続し、会話の新着イベントを購読します。利用可能なMCP / Events機能は自分のChatGPTアカウントで確認します。ブリッジにCodexログイントークンやOpenAI APIキーを渡す必要はありません。

## LINE + 個人用Codex

`init` の設定を作り、`backend` を `codex` に変更します。LINEには `transport: "http"` が必要です。

```bash
./bin/codex-line-bridge init
node --input-type=module -e 'import fs from "node:fs"; const p="bridge.config.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.backend="codex"; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n",{mode:0o600});'
codex login status
./bin/codex-line-bridge channels add --channel line
```

[LINE標準セットアップ](line-setup.md)に従ってHTTPS Webhookを登録し、VerifyとUse webhookを確認します。Gatewayを起動し、初回DMを承認して再度送信します。

```bash
./bin/codex-line-bridge doctor --probe
./bin/codex-line-bridge gateway
```

別の端末で:

```bash
./bin/codex-line-bridge pairing list line
./bin/codex-line-bridge pairing approve line <CODE>
```

## 保存・診断・更新

- `.env`、`bridge.config.json`、`data/` はGitから除外しています。実際のToken / Secretを設定例に書かないでください。
- グループやDiscordサーバーで使う場合は、DM承認とは別に送信者とグループを許可します。[LINE](line-setup.md#access-control) / [Discord](discord-setup.md#guild-workspace)の手順を参照してください。
- ペアリングコードの期限をなくす場合は、対象の `channels.line.pairingCodeTtlMs` / `channels.discord.pairingCodeTtlMs` を `null` にします。省略時はOpenClaw互換の1時間です。設定は新しく発行するコードに適用し、承認済みアクセスは維持します。
- `doctor --probe` は資格情報と実サービス接続を診断します。`gateway status` はローカルプロセスの存在を確認します。AI返信までの確認には承認後の実DMを送ります。
- `gateway` の停止は `Ctrl+C`。更新・バックアップ前に停止し、SQLite本体と関連ファイルを一緒に保存します。更新後は `npm ci --ignore-scripts`、`npm test`、`npm run check` を実行して再起動します。
- 同じ保存領域でGatewayを二重起動しません。起動中のGatewayに対して、別の端末からペアリング・受信箱のCLIを使えます。

## English installation guide

Requirements: Node.js **22.13+**, npm, Git and a POSIX shell. Clone the repository using the commands at the top, then run `npm ci --ignore-scripts`. There are no external runtime npm dependencies. Keep your real configuration in `bridge.config.json`, tokens in `.env` and message data in `data/`; all three are ignored by Git.

Choose a profile:

| Profile | Starting configuration | Changes | Network requirement |
| --- | --- | --- | --- |
| Personal Codex + Discord | Copy `bridge.discord.cloud.example.json` | Set `backend` to `codex`; sign in to your own Codex CLI | Outbound Discord Gateway / HTTPS and Codex access |
| Your dot inbox + Discord | Copy `bridge.discord.cloud.example.json` | Keep `backend: inbox`, `transport: headless` | Outbound Discord Gateway / HTTPS; dot uses the CLI on the same computer |
| Your dot MCP + LINE / Discord | Run `init` | Keep `backend: dot`; set HTTPS public origin and enabled channels | Reachable HTTPS MCP endpoint; LINE also needs its HTTPS webhook |
| Personal Codex + LINE | Run `init` | Set `backend: codex`; sign in to Codex | HTTPS LINE webhook and Codex access |

Follow [Discord setup](discord-setup.md) or [LINE setup](line-setup.md) to create your own bot. `channels add --channel discord` / `line` prompts for credentials without displaying them. Run `doctor --probe`, then `gateway`. Send your first DM and approve its code with `pairing approve discord <CODE>` or `pairing approve line <CODE>` in another terminal. Send a second DM to verify the reply.

Set the channel or account's `pairingCodeTtlMs` to `null` for pairing codes without expiry, or to a positive integer duration in milliseconds. Omission keeps the OpenClaw-compatible one-hour default. The setting affects newly issued codes; existing pending challenges and approved access are preserved.

In the **inbox** profile, use `inbox list --channel discord`, `inbox read <MESSAGE_ID>` and `inbox reply <MESSAGE_ID> --text "Hello" --idempotency-key <REPLY_KEY>`. Use one stable key per reply, including retries. This profile does not wake your dot automatically. Continuous daemon operation on your dot's cloud computer is unverified; see [cloud computer requirements](cloud-computer.md).

In the **dot MCP** profile, use [the integration guide](dot-integration.md) to connect the HTTPS `/mcp` endpoint with OAuth and subscribe to events for an approved conversation. Your account must have access to the required ChatGPT features. Public source code does not imply a published or approved ChatGPT plugin.

The **personal Codex** profiles use your own local Codex login. Approval requests are sent back to the requester; the default sandbox is read-only. This is local / open-source authentication, subject to [OpenAI's App Server conditions](https://learn.chatgpt.com/docs/app-server), rather than authentication for a commercial hosted service. Each permitted sender shares the host's Codex environment; this project does not provide per-user OS isolation.
