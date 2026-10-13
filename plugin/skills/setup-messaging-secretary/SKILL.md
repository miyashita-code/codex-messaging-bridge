---
name: setup-messaging-secretary
description: Set up this bridge's LINE or Discord connection for Your dot, routing to MCP event subscriptions or the same-computer Discord inbox mode.
---

Preserve the channel and operating mode the owner requested.

- For LINE through the connected MCP plugin, follow [setup-line-secretary](../setup-line-secretary/SKILL.md).
- For Discord through the connected MCP plugin, follow [setup-discord-secretary](../setup-discord-secretary/SKILL.md).
- For Discord without a hosted endpoint, on the same computer as the bridge, follow [use-discord-cloud-inbox](../use-discord-cloud-inbox/SKILL.md).

The headless inbox and MCP-event modes have different wakeup behavior. Do not infer a live event subscription from a running inbox process, and do not promise cloud-computer uptime without an actual test.
