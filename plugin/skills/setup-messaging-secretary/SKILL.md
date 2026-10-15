---
name: setup-messaging-secretary
description: Set up this bridge for Your dot from its repository, prepare the cloud runtime, and use a connected computer for LINE or Discord account steps before verifying the requested reply path.
---

Preserve the channel and operating mode the owner requested.

When asked to set up the repository, locate its root and read `AGENTS.md` and `docs/agent-onboarding.md`. If only this plugin is installed, obtain the [repository setup guide](https://github.com/miyashita-code/codex-messaging-bridge/blob/main/docs/agent-onboarding.md) and clone the owner's selected revision on the intended computer before running its CLI.

Run `setup plan`, then `setup prepare` with the selected target and channel. The default target is `dot-cloud` with both channels and the dot backend. Preparation uses a private `data/setup/<target>/` directory and preserves existing settings. Resume using its `setup-state.json`; preparation is not a live connection or an uptime test.

When Sites is available and the owner requests no separate hosting contract, evaluate `adapters/sites/README.md` before provisioning a Node host. Use the installed Sites skill and native Site/plugin/D1/schedule workflow. Sites has different tool arguments; follow the Sites section of `docs/dot-integration.md` and the actually discovered schema. A cloud browser timer and a saved schedule are not verified unattended recovery. Check the account cadence limit and prove a new reply with local receivers stopped; disable each old owned service's autostart after its successful cutover and preserve rollback.

Use the dot's supported connected-computer tools for account steps that require the owner's signed-in local browser. Preserve the owner's existing authorization and continue ordinary setup work without asking for it again. Follow the active tool's requirements for human authentication or consent. Keep tokens in the intended runtime's private secret store; never copy the Mac's Codex login, browser profile, or a whole dotenv file to the cloud. Transfer only the credentials required for the chosen bot through an authenticated private route.

For cloud automatic replies, verify a durable runtime, the actual MCP connection and OAuth scopes, an event subscription, and a real message through the dot back to the originating conversation. LINE also requires a publicly reachable HTTPS webhook. An imported plugin containing an MCP server declaration can be Desktop only; verify the actual cloud app/connector rather than assuming this repository manifest registers one.

- For LINE through the connected MCP plugin, follow [setup-line-secretary](../setup-line-secretary/SKILL.md).
- For Discord through the connected MCP plugin, follow [setup-discord-secretary](../setup-discord-secretary/SKILL.md).
- For Discord without a hosted endpoint, on the same computer as the bridge, follow [use-discord-cloud-inbox](../use-discord-cloud-inbox/SKILL.md).

The headless inbox and MCP-event modes have different wakeup behavior. Do not infer a live event subscription from a running inbox process. Keep a working local bridge until a safe cutover is ready; do not run duplicate consumers for the same bot. Claim independence from the laptop only after a fresh message receives a reply while its local gateway and local resources are unavailable, using a test method authorized by the owner. Do not power off the owner's computer merely to prove this.
