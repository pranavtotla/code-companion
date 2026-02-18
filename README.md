# Code Companion

Share a terminal session with anyone — in real time, from the browser.

One person creates a room, others join with a 6-character code. Everyone sees the same terminal. Everyone can type. A typing indicator shows who's active.

## How it works

- The server spawns a bash shell in a pseudo-terminal (PTY)
- socket.io streams terminal output to all connected browsers
- xterm.js renders the terminal in the browser
- Room-based system — no accounts, just a shareable code

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, create a room, and share the code.

## Expose over the internet

```bash
ngrok http 3000
```

Share the ngrok URL — others open it, enter the room code, and they're in.

## Tech stack

- **Server:** Node.js, Express, socket.io, Python PTY helper
- **Client:** xterm.js, socket.io-client
- **Tests:** vitest (28 tests)

## Running tests

```bash
npm test
```

## License

MIT
