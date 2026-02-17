# Shared Claude Code — Design Document

## Problem

Two people want to collaborate in the same Claude Code session simultaneously — for pair programming and cross-expertise knowledge sharing.

## Solution

A web-based shared terminal that wraps the real `claude` CLI. One person creates a session and gets a shareable room code. The other joins. Both see the same terminal output and can both type input.

## Architecture

```
User A (browser + xterm.js) ──WebSocket──┐
                                          ├──→ Node.js Server ──PTY──→ claude CLI
User B (browser + xterm.js) ──WebSocket──┘
```

- **Server** spawns `claude` in a pseudo-terminal (`node-pty`)
- **socket.io** provides WebSocket transport with room-based multiplexing
- **xterm.js** in the browser renders the full terminal experience (colors, cursor, TUI)
- Both users can type at any time; a typing indicator shows who's active

## Server

- Express + socket.io
- `node-pty` spawns `claude` in a PTY per room
- Room management:
  - `POST /rooms` — create room, spawn `claude`, return 6-char code
  - Host specifies working directory (defaults to server cwd)
  - Max 2 connections per room
- WebSocket events:
  - `terminal:output` — PTY stdout broadcast to all clients in room
  - `terminal:input` — client keystroke written to PTY stdin
  - `user:typing` — debounced typing indicator broadcast
  - `user:joined` / `user:left` — presence events
- When `claude` process exits, room closes

## Client

- Single-page app served by Express
- Landing page: create room (pick display name) or join (enter code + display name)
- Session page:
  - `xterm.js` terminal filling most of the screen
  - Status bar: room code, connected users, typing indicator
- `xterm.js` `onData` → emit `terminal:input`
- Listen for `terminal:output` → write to `xterm.js`

## Input Coordination

Both users have equal input access. A typing indicator ("Alex is typing...") shows who's currently sending keystrokes, so users can coordinate socially without a hard turn-based lock.

## Dependencies

- `node-pty` — spawn Claude Code in a PTY
- `socket.io` / `socket.io-client` — WebSocket with rooms
- `xterm.js` + `@xterm/addon-fit` — terminal rendering in browser
- `express` — serve client + room API
- `nanoid` — generate room codes

## Project Structure

```
shared-claude-code/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts          # Express + socket.io + PTY management
│   └── rooms.ts           # Room lifecycle (create, join, destroy)
├── public/
│   ├── index.html          # Landing + session UI
│   ├── client.ts           # xterm.js + socket.io client
│   └── style.css
```

## Non-Goals (for MVP)

- User accounts or authentication
- Persistent session history
- More than 2 users per room
- File upload between users
- Permission differentiation between host and guest
