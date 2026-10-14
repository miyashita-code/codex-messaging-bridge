# Agent setup entry point

This repository is a LINE / Discord bridge for Your dot, with an optional personal local Codex backend. When the user gives you this repository to install or run their AI secretary, carry the setup through to a verified result. Follow [the agent onboarding guide](docs/agent-onboarding.md); do not stop at describing commands.

## Start in the requested environment

- When Sites is available and the user requests no separate hosting contract, evaluate [the Sites cloud adapter](adapters/sites/README.md) for public LINE ingress and cloud recovery. Use its actual Site/plugin/subscription workflow and test it with local receivers stopped. Do not equate a cloud browser timer or saved schedule with verified always-on service.
- For a Your dot cloud request, work on its cloud computer first. Run `./bin/codex-line-bridge setup plan --target dot-cloud --channel both --mode dot`, then `setup prepare` with the same options. If the user selected one channel, use `--channel line` or `--channel discord`. Use Node.js 22.13 or newer.
- When starting from local Codex with permitted browser tools, check the normal `https://chatgpt.com/` web route before asking the user to open the cloud computer. Observe the loaded account, select the user's actual Your dot, then its profile → Computers → Open computer → Take over. If an available `open_in_codex` browser request is queued because this chat is hidden, show this chat with the supported `navigate_to_codex_page` tool and inspect the resulting browser. Recheck loading or initial sign-in screens; do not assume authentication or session inheritance. See [the onboarding access steps](docs/agent-onboarding.md#cloud-computerを開く入口).
- A protected native app refusal is not permission to operate the same app through another native driver. Use only an independently permitted normal website route with documented browser controls; never guessed deep links, internal app APIs, or copied cookies/login files. Follow the active tool's handoff rules if sign-in or another human step is actually required.
- These commands prepare private files under `data/setup/dot-cloud/`: `bridge.config.json`, `.env`, and `setup-state.json`. Preparation is a scaffold, not a running deployment. Preserve existing files and resume their plan; never overwrite a working installation to reset setup.
- On the user's local computer, use `--target local` and the requested channel. The default local mode is personal `codex`; cloud mode defaults to `dot` and rejects `codex`. Choose `--mode inbox --channel discord` only when the user explicitly accepts a CLI inbox without automatic dot wakeup.
- Before creating a local installation, look for an existing private configuration already identified by the user or this task. Reuse that configuration and its approval state where appropriate; do not search unrelated credentials or copy whole `.env` files.
- New setup profiles use pairing codes without expiry. When the owner requests this for a reused installation, review its channel and account overrides, change only the applicable `pairingCodeTtlMs` values to `null`, and reload the owned runtime safely. `prepare` intentionally preserves existing values; do not reset its configuration or approval database to change this setting.

## Use local access for account setup

- Use the product's actual supported connected-computer tools to delegate LINE / Discord account setup to the user's already authorized local computer. Carry the approved goal and necessary non-secret context into the local task. Do not invent a tool, API, or automatic browser-session transfer.
- Reuse authorization already given in the task. Continue routine reversible setup without repeating generic permission questions. Respect the active tool's rules for passwords, OTPs, CAPTCHAs, terms, and other steps requiring a human handoff or a specific approval.
- Put credentials only in the designated private runtime secret store or `.env`, with restrictive permissions. Never echo them, place them in chat, commit them, or include them in setup reports.
- Cloud operation needs its own credentials and access. Transfer only explicitly authorized, necessary bot connection secrets using an authenticated, encrypted path supported by the environment. If no such path exists, prepare a private secret-entry handoff. Never export Codex login files, browser cookies, unrelated credentials, conversation history, or the whole local data directory.

## Prove the runtime and connection

- Inspect actual capabilities: Node/SQLite, a persistent private data directory, outbound API HTTPS, Discord WSS when enabled, process survival after a task ends, and a supported restart mechanism. LINE also needs a reachable HTTPS webhook with valid TLS. A passing `cloud-check --probe` does not prove daemon uptime or restart persistence.
- Your dot automatic replies require an actual cloud-usable MCP connection, OAuth with the enabled channels' read/write scopes plus `events:subscribe`, discovered tools/events, and a verified active subscription. A GitHub-imported plugin declaring an MCP server is Desktop only, even for a remote HTTPS URL; do not treat installing its manifest as a cloud connector.
- Use [Your dot integration](docs/dot-integration.md). Verify actual LINE / Discord input, authorization, delivery to Your dot, and a reply received in the same conversation. Webhook Verify, mocked tests, callback `2xx`, or local Codex replies alone are insufficient.
- Approve only pairing codes tied to the verified owner or an authorized test sender. Do not approve all pending senders. During an authorized migration, preserve only the necessary sender approvals and policies through a reviewed mechanism; do not move whole conversation databases to carry approvals.
- Your dot cloud work being available while a PC is off does not establish that an arbitrary bridge daemon, public URL, or WebSocket remains available. Mark unknown capabilities as unverified and record the exact remaining step.

## Migrate without disrupting the working bot

- Keep an existing working local runtime until the cloud path is prepared and validated. Identify the owned consumers, queue, account, and endpoint before a coordinated cutover; avoid two active consumers for the same bot or database.
- Record the prior endpoint and service state, complete pending work, then make only the authorized, scoped cutover. Verify new messages and restart behavior; restore the prior working path if the cutover fails. Never kill arbitrary services or overwrite an endpoint belonging to another account.
- Call the installation independent of the laptop only after an actual test with its local bridge/resources unavailable proves new messages still reach Your dot and receive replies. A scoped stop of owned local services may be part of an authorized migration, with rollback ready. Do not shut down the user's PC or revoke broader access without authorization.
- Do not silently substitute local mode, provision a paid host, create API credentials, or add recurring jobs. When a required capability is unavailable, finish all independent preparation, save resumable non-secret state, and report the concrete missing capability and next action.

## Report and maintain

Report the chosen runtime, channels, connection mode, actual checks completed, laptop dependence, and remaining gates. Keep secret values and private account identifiers out of public artifacts. Run relevant tests and `npm run check` after source changes; verify generated configuration and the package after setup changes.

Official product behavior and the boundaries above are linked in [agent onboarding](docs/agent-onboarding.md) and [cloud computer operation](docs/cloud-computer.md).
