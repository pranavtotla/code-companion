---
name: session-sharing
description: Use when users want to share their terminal, collaborate in real-time, or let someone else see their CLI session. Triggers on "share session", "share terminal", "pair program", "collaborate", "let someone see my terminal".
---

# Session Sharing with Code Companion

You have access to terminal session sharing tools via the `code-companion` MCP server.

## Available Tools

- `create_session` - Start a shared terminal session. Accepts optional `cwd` (working directory) and `tunnel` (boolean for remote access).
- `list_sessions` - Show all active shared sessions.
- `get_session_info` - Get details about a specific session by room code.
- `stop_session` - Stop a specific session by room code.
- `stop_server` - Stop all sessions and the sharing server.

## How It Works

1. Creating a session starts a bash shell in a PTY and makes it accessible via browser
2. A 6-character room code is generated for joining
3. Anyone with the room code can join via the browser URL
4. All participants see and can type into the same terminal
5. Sessions are ephemeral - they end when stopped or when all users disconnect

## Usage Patterns

- **Quick share**: Create a session with tunnel for remote access, share the URL
- **Local collaboration**: Create a session without tunnel for same-network access
- **Multiple sessions**: You can run multiple independent sessions simultaneously
