# Code Companion

Share a Claude Code terminal session with someone else — in real time, from the browser.

One person creates a room, the other joins with a 6-character code. Both see the same terminal. Both can type. A typing indicator shows who's active.

## How it works

- The server spawns the real `claude` CLI in a pseudo-terminal (PTY)
- A WebSocket (socket.io) streams terminal output to all connected browsers
- xterm.js renders the terminal in the browser
- Room-based system — no accounts, just a shareable code

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, create a room, and share the code.

> Requires `claude` CLI installed and available in your PATH.

## Expose over the internet

```bash
ngrok http 3000
```

Share the ngrok URL — the other person opens it, enters the room code, and they're in.

## Tech stack

- **Server:** Node.js, Express, socket.io, Python PTY helper
- **Client:** xterm.js, socket.io-client
- **Tests:** vitest (31 tests)

## Running tests

```bash
npm test
```

## License

MIT
