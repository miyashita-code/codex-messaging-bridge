# Security policy

## 脆弱性の報告 / Reporting a vulnerability

認証・認可の回避、秘密情報の流出、別会話への漏洩などは、GitHubの[非公開の脆弱性報告](https://github.com/miyashita-code/codex-messaging-bridge/security/advisories/new)から連絡してください。公開Issueにはtoken、cookie、ログイン情報、実際の会話本文、本人用の設定を貼らないでください。

Please use [GitHub private vulnerability reporting](https://github.com/miyashita-code/codex-messaging-bridge/security/advisories/new). Include the affected commit, runtime (Node or Sites), prerequisites, expected/actual behavior and a minimal reproduction using invented data. Do not include live credentials or private conversations. General setup questions belong in Issues with redacted diagnostics.

セキュリティ修正の対象は最新の `main` です。過去のリリースへのバックポートや対応期限は約束していません。

## Trust boundaries

- **Personal installations.** Each operator supplies their own Bot credentials, account authorization and private storage. The local Codex backend uses that operator's Codex access; a paired sender does not receive a separate operating-system sandbox. Treat allowed senders as users of the operator's configured AI tools.
- **Sites authentication.** The adapter trusts the authenticated identity supplied by the Sites platform and compares it to the configured owner. A client-provided `oai-authenticated-user-id` header is not authentication on a generic host. A port must implement an authenticated, trusted edge before using this adapter outside Sites.
- **Messaging authorization.** Node pairing and group allowlists are separate controls. Sites uses explicit owner/sender and guild/channel policies. Inviting a Bot does not automatically authorize a new server, sender or cloud connection.
- **Conversation scope.** Cloud claims and encrypted history are scoped to their source conversation, and replies recheck current access. The owner's MCP connection can still read multiple authorized conversations. The AI task must keep those contexts separate and treat messages, embeds and attachments as untrusted data. Prompt instructions supplement access controls; they do not create independent tenant isolation.
- **Delivery outcomes.** Durable action reservations and send fences suppress duplicate replies. `unknown`, `reserved` or failed outcomes require review; deleting their records to force a resend can duplicate external effects.
- **Attachments.** Sites text reads use IDs from an authorized Discord message, recheck the source, accept only bounded UTF-8 text from its expected Discord CDN path and reject redirects. This does not make the attachment's instructions trustworthy.

## Credentials and data

Keep secrets in private runtime settings or a restricted `.env`. The repository ignores active configuration, `data/`, SQLite and logs; the cloud archive uses a source allowlist. Review files before committing, because Git ignore rules do not remove already tracked files.

Never export Codex login files or browser cookies into cloud tasks, issue reports or distribution archives. If a real credential is exposed, revoke or rotate it at its provider; removing it from the latest file does not remove it from Git history.

The Node backend's default Codex sandbox is `read-only`; changing it changes what approved senders can ask that Codex process to do. The existing app-server login path is for local/open-source use under [OpenAI's authentication conditions](https://learn.chatgpt.com/docs/app-server). This project is not a multi-tenant hosted-service authentication system.

The Sites receiver is experimental. Its bounded conversation history, allowlists, provider/platform retention and backups are different mechanisms. Logical expiry of a history record does not guarantee physical removal from all stored copies. See [the adapter's storage and runtime details](adapters/sites/README.md).
