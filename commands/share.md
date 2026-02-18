---
name: share
description: Share a terminal session — creates a room and returns a join link
allowed-tools:
  - mcp__plugin_code-companion_code-companion__create_session
---

Create a shared terminal session for the user's current working directory.

1. Call the `create_session` tool with:
   - `cwd`: the user's current working directory
   - `tunnel`: true (to enable remote access if cloudflared is available)
2. Present the results clearly:
   - Room code (for manual sharing)
   - Local URL (for same-network access)
   - Tunnel URL (if available, for remote access)
3. Suggest the user can share the URL or room code with others
4. Mention they can stop sharing with `/share-stop`
