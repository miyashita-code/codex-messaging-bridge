# OpenClaw LINE compatibility reference

Investigated on **2026-10-13 JST** against official documentation and OpenClaw
`main` commit [`2d924dfeba5550ce3427ccf44b579db127fd7f60`](https://github.com/openclaw/openclaw/tree/2d924dfeba5550ce3427ccf44b579db127fd7f60).
The current LINE implementation lives in `extensions/line/src/`; `src/line/` no
longer exists on this revision. This document distinguishes the upstream contract
from the subset implemented by this independent Codex bridge. The upstream
[license](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/LICENSE)
is MIT; copying substantial upstream code requires retaining its notice.

## Transport and admission

The reference channel uses LINE Messaging API webhooks with a channel access
token and channel secret. The default route is `/line/webhook`; each account can
override it. HTTPS must terminate at a public endpoint. Official setup requires
a Messaging API channel, an endpoint registered in LINE Developers Console,
**Use webhook** enabled, and preferably **Webhook redelivery** enabled.
No native LINE slash-command registry, message editing, reactions or chat threads
exist on this channel. [Official LINE channel guide](https://docs.openclaw.ai/channels/line)

The exact HTTP contract from
[webhook-node.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/webhook-node.ts)
and [signature.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/signature.ts):

- Authenticate HMAC-SHA256 of raw request bytes against base64 `X-Line-Signature`
  with a timing-safe comparison. Never sign or process reserialized JSON instead.
- Read at most 64 KiB before authentication; raw-body deadline 5 seconds.
- Missing signature: 400. Invalid or ambiguously matching account signature: 401.
  Invalid JSON: 400. Oversize: 413. Body timeout: 408. Persistence failure: 500.
- POST with signed `events: []` is a successful verification ping. Signed standby
  events are ignored because another channel holds conversation control.
- Active events are persisted before returning 200. The reference marks durable
  acknowledgements with `x-openclaw-delivery-accepted: durable`; pings and
  standby-only batches omit this header.
- GET returns 200 text `OK`; HEAD returns 204; other methods return 405.

## Durable event processing

Source:
[webhook-spool.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/webhook-spool.ts),
[webhook-spool-contract.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/webhook-spool-contract.ts).

- Deduplication identity is `message:<message.id>` for messages, otherwise
  `event:<webhookEventId>`. Missing a stable delivery identity is invalid.
- Ordering lane is the entire `group:<groupId>` or `room:<roomId>`, not individual
  members; DMs use `user:<userId>`. Events without a source use their event ID.
- Dispatch in received order with up to 8 concurrent lanes, a 500 ms drain pump
  and scan limit 100. A retry holds its place ahead of later events in that chat.
- Upstream retries 8 failed attempts with exponential delay starting at 1 second.
  Failure becomes a dead letter immediately after attempt 8, without a 24-hour
  minimum age. Payload-invalid, already-committed side effects and LINE 401/403
  errors are immediately terminal.
- The pre-adoption watchdog is 5 minutes. Adoption clears it; long running agent
  turns are not interrupted by it. Crash recovery reclaims dead process owners;
  the fallback claim lease is 30 minutes.
- New events can still persist while stopping. Completion/failure dedup records
  expire after 30 days and cap at 4096 of each kind per account, pruned on admission.
- The boundary is at-least-once. External side effects require their own idempotency.

## Configuration and credentials

Source:
[config-schema.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/config-schema.ts),
[accounts.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/accounts.ts).

The compatibility vocabulary is `enabled`, `channelAccessToken`, `channelSecret`,
`tokenFile`, `secretFile`, `webhookPath`, `dmPolicy`, `allowFrom`, `groupPolicy`,
`groupAllowFrom`, `groups`, `mediaMaxMb`, `historyLimit`, `joinIntro`,
`responsePrefix`, `replyToMode`, `streaming`, `name`, `configWrites`,
`threadBindings`, and `accounts.<id>`/`defaultAccount`.

Upstream policy defaults are DM `pairing`, group `allowlist`, media 10 MiB,
join introductions enabled and automatic quoting `off`. A channel or account
`enabled: false` disables that account. Named account settings inherit channel
policy settings, but named credentials do **not** inherit another account's keys.
Credential priority within a scope is inline value then configured file. Only
the default account falls back to channel credentials then
`LINE_CHANNEL_ACCESS_TOKEN`/`LINE_CHANNEL_SECRET`. A configured unreadable file
fails closed; it does not silently fall back. Credential files must be regular
files; symlinks are rejected. Account credential availability is separate from
configuredness so diagnostics can explain inaccessible files without printing keys.

## Pairing and access policy

Source:
[bot-handlers.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/bot-handlers.ts),
[pairing-store-model.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/src/pairing/pairing-store-model.ts),
[pairing-challenge.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/src/pairing/pairing-challenge.ts).

- DM policy: `pairing | allowlist | open | disabled`. Public `open` requires `*`
  in `allowFrom`. Unknown pairing senders receive a challenge and their message
  is not passed to the agent until the owner approves locally.
- Codes are 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, expire after
  1 hour, and pending challenges cap at 3. Repeated messages retain a pending
  code; only a newly created challenge sends the challenge notice.
- Upstream owner commands: `openclaw pairing list line` and
  `openclaw pairing approve line <CODE>`. The approval persists an account-scoped
  allow entry and can send an approval notification.
- Group policy: `allowlist | open | disabled`. DM allow entries and pairing
  approvals never implicitly authorize group senders. Use `groupAllowFrom` or
  `groups.<id>.allowFrom`. Empty group allowlists deny messages.
- An explicit per-group allowlist narrows even an otherwise open group policy.
  `groups.<id>.enabled: false` always denies. Wildcard `groups['*']` defaults
  merge field by field into named group and room entries.
- Additional upstream per-group fields: `requireMention`, `systemPrompt`,
  `skills`. Empty `skills` means no skills rather than no override.
- Upstream static entries may expand `accessGroup:<name>`; such symbolic entries
  are policy data, never addresses to send to.

## Mentions, quoting and history

Source:
[mentions.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/mentions.ts),
[quote-tokens.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/quote-tokens.ts),
[outbound-message-log.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/outbound-message-log.ts).

Groups normally require addressing the bot. Native `mentionees[].isSelf === true`
and `type: 'all'` both count; configured identity mention patterns are also used.
Command parsing removes only authoritative mention spans using LINE's UTF-16
`index`/`length`, keeping spaces so neighboring text cannot turn into an invented
command. Authorized control commands can activate the bot under shared policy.

A quote of a recently remembered bot message also activates the bot unless shared
`channels.defaults.implicitMentions.quotedBot` is false. Bot-message identity is
bounded in memory per account. Messages skipped for lack of mention contribute
to bounded ambient group history; they are not addressable outbound quote targets.

Automatic outbound quoting supports `off | first | all`. Inbound text, image,
video and sticker messages can supply quote tokens; outbound text and stickers
can carry them. Tokens are cached for the most recent 500 inbound messages per
account and chat-bound. Button postbacks have no message to quote. Flex/media/
location-only replies remain unquoted. Upstream drops quote tokens and retries a
definitively refused HTTP 400 request once. A restart loses upstream token caches.

## Reply and push reliability

Sources:
[send.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/send.ts),
[auto-reply-delivery.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/auto-reply-delivery.ts),
[send-retry.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/send-retry.ts),
[LINE retry documentation](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/).

- At most 5 message objects per API request. Use the one-use reply token for the
  first batch and push subsequent batches. Long replies are split at 5000 UTF-16
  units, preserving surrogate boundaries.
- A stable UUID `X-Line-Retry-Key` identifies each logical push. Reuse it with
  **identical** recipient and body for every retry, including after a restart.
  Keys are retained by LINE for 24 hours.
- A push HTTP 409 with `x-line-accepted-request-id` is an already accepted
  request, not a second delivery. Its `sentMessages` repeat the accepted receipt.
- Upstream immediate push retries cover 5xx and transient transport failures.
  429 is separately classified for queue retry; a quota probe can identify an
  exhausted monthly allowance and stop pointless retries.
- Reply transport/5xx failures can have an unknown delivery outcome. Replaying
  through push could duplicate a reply. This bridge only allows core fallback
  for a definitive HTTP 400 **Invalid reply token** response, a stricter rule
  than upstream's broader definite-rejection fallback.
- Once a provider accepted any batch, missing receipt bytes or failed local
  bookkeeping must not trigger the whole turn again. Mark a partial/committed
  delivery and retain its receipt when possible.

## Inbound media, identity and lifecycle events

Source:
[download.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/download.ts),
[inbound-image-set.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/inbound-image-set.ts),
[bot-message-context.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/bot-message-context.ts).

Upstream downloads `image | video | audio | file` content from
`https://api-data.line.me/v2/bot/message/<id>/content`, without redirects. Poll
HTTP 202 preparation up to 6 attempts using 500 ms exponential delays capped at
4 seconds. The 15-second deadline spans headers through EOF, and streamed size
enforcement applies even when Content-Length is absent. Permanent unavailable or
oversize media degrades to an honest unavailable notice; temporary readiness,
408/429/5xx/network failures retry before adopting the agent turn.

Image sets use conversation + sender + `imageSet.id`, deduplicate message IDs,
sort by `imageSet.index` with arrival order for missing indices, and become one
turn. An incomplete set flushes 4 seconds after the latest part; later messages
wait behind it. The freshest part supplies the reply token. Partial sets can
report missing images only when a total was actually announced.

Locations carry coordinates, title and address. Stickers prefer sender-authored
text, otherwise the first 3 supplied keywords, otherwise a neutral sticker label.
Empty inline LINE emoji `()` alternatives become `[emoji]` only at metadata
positions; meaningful alternatives and typed parentheses remain.

Upstream profile/group name lookups cache for 5 minutes. Group/room users are
looked up through that conversation so non-friends can resolve. Lookup failure
falls back to raw IDs; rooms have no name endpoint. A bot `join` may trigger one
introduction in an allowed group/room using available metadata, no invented prior
history and no tools. `follow`, `unfollow`, `leave` are logged rather than agent
turns; other event types are acknowledged and logged as unhandled.

## Formatting, controls and outbound media

Sources:
[markdown-to-line.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/markdown-to-line.ts),
[rich-messages.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/rich-messages.ts),
[template-messages.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/template-messages.ts),
[outbound-media.ts](https://github.com/openclaw/openclaw/blob/2d924dfeba5550ce3427ccf44b579db127fd7f60/extensions/line/src/outbound-media.ts).

Upstream strips ordinary Markdown, preserves link destinations and can turn code
blocks/tables into Flex cards. Code above 2000 characters and oversized tables
remain complete readable text. Bubble JSON caps at 30000 bytes, carousel at
50000 bytes. Quick replies cap at 13 per message with native labels 20 characters;
overflow options remain in readable text. Keep the quick-reply carrier last,
since later messages dismiss previous quick replies. Templates support confirm,
buttons and carousel; titles cap at 40, alt text at 1500, with type-specific body
and action limits. `/card` supports info, image, action, list, receipt, confirm and
buttons presets. Legacy `[[buttons: ...]]` markers are plain text.

Upstream portable `buttons` become Flex controls; `select` becomes quick replies.
One DM question with 2–4 distinct non-secret options can use direct question
postbacks carrying a canonical option index, not an inferred label. Other shapes
and groups/rooms use text fallback. Expired controls stay visible because LINE
cannot edit; stale taps receive a terminal-question notice. Free-text `Other…`
remains text. Native event/agenda/device/media-player/Apple-TV cards are upstream
extras rather than requirements for the basic bridge.

Outbound images/videos/audio require public HTTPS media URLs no longer than
2000 characters. Image preview defaults to image URL; videos require a preview;
audio needs duration metadata (upstream fallback 60000 ms). Inferred supported
suffixes are JPEG/PNG, MP4, MP3/M4A. Unsupported suffixes and inferred video without
preview become text links. Tracking IDs are DM-only. Upstream additionally resolves
hostnames under a public-network SSRF policy before handing them to LINE.

## Bridge LINE client implementation

`src/line.mjs` implements raw signature checking, lossless text chunking, native
message envelope/limit validation, reply/push, direct loading indicators, scoped
profile lookup, bot/group/webhook/quota probes, and private atomic streamed media
files. `LINEError` carries `status`, `retryable`, `uncertain`, `accepted`,
`acceptedRequestId`, `requestId`, `invalidReplyToken` and `code`, without raw
credential-bearing causes. Push callers own persistent retry keys; there is no
hidden transport retry loop that generates new keys. Reply/push return
`sentMessages`, `messageIds`, `receiptComplete`, and acceptance metadata. A 409
accepted request succeeds even if its receipt is unavailable. Corrupt 2xx send
JSON is marked accepted/uncertain and not retryable.

Native validation supports text, image, video, audio, sticker, location, template,
Flex and quick replies. The validator rejects invalid/oversized payloads instead
of silently clipping authored content. It rejects literal local/private media
hosts and credential-bearing URLs; it does not perform upstream's full DNS
resolution policy or validate every Flex layout property. Native LINE server
validation remains authoritative. It does not fetch remote media to determine
actual image/video formats or sizes.

The core additionally implements conversation routing, pairing, SQLite queues,
image-set buffering, static once-per-group join introductions, sender-bound
Codex approval controls, and a Markdown-to-Flex formatter in `src/format.mjs`.
It does not implement `/card` presets, automatic quote-token insertion/retry,
streaming-block coalescing, ambient group history, ACP runtime, generated group
introductions or the complete upstream question-presentation gateway. Dot memory
belongs to Your dot; the alternative Codex adapter keeps independent threads.

The durable marker is `x-bridge-delivery-accepted: durable`. Missing signatures
return 400; invalid signatures return 401. Message IDs take priority over
webhookEventId for deduplication. A 10000-pending queue cap is configurable.
Completed/dead ingress records and admitted media expire after 30 days by default.
Interrupted Codex tool work is not automatically replayed after a crash: it is
dead-lettered for review. Stored completed answers can retry their delivery without
running Codex again. Push failures with stable retry keys can retry safely;
uncertain reply outcomes are held for review. These are intentional deviations
from upstream's broader at-least-once agent adoption recovery.

Meaningful transport checks are in `tests/line.test.mjs`: raw signature mutation,
UTF-16 boundaries, native message limits, stable retry/409 identity, safe reply
fallback, uncertain outcomes, credential redaction, download size checks,
private file mode, symlink refusal and media preparation polling. These run with
fake LINE responses and require no account token or external message delivery.
