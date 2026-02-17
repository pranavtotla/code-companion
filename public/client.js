(function () {
  const $ = (sel) => document.querySelector(sel);
  const landingPage = $("#landing");
  const sessionPage = $("#session");
  const roomCodeDisplay = $("#room-code-display");
  const usersDisplay = $("#users-display");
  const typingDisplay = $("#typing-display");

  let socket = null;
  let term = null;
  let fitAddon = null;
  let typingTimeout = null;

  // Clean up any previous socket before creating a new one
  function cleanupSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  }

  // --- Landing Page Handlers ---

  $("#btn-create").addEventListener("click", async () => {
    const name = $("#create-name").value.trim() || "Host";
    const cwd = $("#create-cwd").value.trim() || undefined;

    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, hostName: name }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to create room");
      return;
    }

    const { code } = await res.json();
    joinRoom(code, name);
  });

  $("#btn-join").addEventListener("click", () => {
    const name = $("#join-name").value.trim() || "Guest";
    const code = $("#join-code").value.trim().toLowerCase();

    if (!code || code.length !== 6) {
      alert("Enter a 6-character room code");
      return;
    }

    joinRoom(code, name);
  });

  // --- Session Logic ---

  function joinRoom(roomCode, displayName) {
    roomCodeDisplay.textContent = "Room: " + roomCode;

    const copyBtn = document.querySelector("#btn-copy-code");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(roomCode).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
    });

    // Set up xterm.js
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      theme: {
        background: "#0f0f23",
        foreground: "#e0e0e0",
        cursor: "#5865f2",
      },
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($("#terminal-container"));
    fitAddon.fit();

    // Clean up any previous connection
    cleanupSocket();

    // Connect socket.io
    socket = io({
      query: { roomCode, displayName },
      transports: ["websocket"],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    // Terminal output from server
    socket.on("terminal:output", (data) => {
      term.write(data);
    });

    // Terminal exited
    socket.on("terminal:exit", ({ exitCode }) => {
      term.write("\r\n\x1b[33m[Claude exited with code " + exitCode + "]\x1b[0m\r\n");
    });

    // User input to server
    term.onData((data) => {
      socket.emit("terminal:input", data);
      socket.emit("user:typing");
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit("user:stop-typing");
      }, 1000);
    });

    // Resize
    term.onResize(({ cols, rows }) => {
      socket.emit("terminal:resize", { cols, rows });
    });

    window.addEventListener("resize", () => {
      if (fitAddon) fitAddon.fit();
    });

    socket.on("connect", () => {
      // Only show session page once socket is actually connected
      landingPage.classList.add("hidden");
      sessionPage.classList.remove("hidden");
      fitAddon.fit();
      socket.emit("terminal:resize", { cols: term.cols, rows: term.rows });
    });

    // Presence
    socket.on("user:joined", ({ name, users }) => {
      usersDisplay.textContent = "Users: " + users.join(", ");
      if (name !== displayName) {
        term.write("\r\n\x1b[36m[" + name + " joined]\x1b[0m\r\n");
      }
    });

    socket.on("user:left", ({ name, users }) => {
      usersDisplay.textContent = "Users: " + users.join(", ");
      term.write("\r\n\x1b[33m[" + name + " left]\x1b[0m\r\n");
    });

    // Typing indicator
    socket.on("user:typing", ({ name }) => {
      typingDisplay.textContent = name + " is typing...";
    });

    socket.on("user:stop-typing", () => {
      typingDisplay.textContent = "";
    });

    // Errors
    socket.on("error:room", ({ message }) => {
      alert("Error: " + message);
      sessionPage.classList.add("hidden");
      landingPage.classList.remove("hidden");
    });

    socket.on("disconnect", (reason) => {
      console.log("Socket disconnected. Reason:", reason);
      term.write("\r\n\x1b[31m[Disconnected from server: " + reason + "]\x1b[0m\r\n");
    });

    socket.on("reconnect_failed", () => {
      term.write("\r\n\x1b[31m[Failed to reconnect. Refresh to try again.]\x1b[0m\r\n");
    });

    socket.on("reconnect", () => {
      term.write("\r\n\x1b[32m[Reconnected]\x1b[0m\r\n");
    });
  }
})();
