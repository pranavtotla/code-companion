#!/usr/bin/env python3
"""
PTY helper: creates a proper pseudo-terminal and relays stdin/stdout.
Works with piped stdio from Node.js — no terminal required on the parent side.
Usage: python3 pty-helper.py <command> [args...]
"""
import pty
import os
import sys
import select
import struct
import fcntl
import termios
import signal


def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    master_fd, slave_fd = pty.openpty()

    cols = int(os.environ.get("COLUMNS", "120"))
    rows = int(os.environ.get("LINES", "40"))
    set_winsize(master_fd, rows, cols)

    pid = os.fork()
    if pid == 0:
        # Child: connect slave PTY as stdin/stdout/stderr and exec command
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        os.execvp(sys.argv[1], sys.argv[1:])
    else:
        # Parent: relay between piped stdin/stdout and the master PTY fd
        os.close(slave_fd)

        # Handle SIGUSR1 to resize the PTY (sent by Node with cols:rows in env)
        def handle_resize(signum, frame):
            try:
                c = int(os.environ.get("COLUMNS", "120"))
                r = int(os.environ.get("LINES", "40"))
                set_winsize(master_fd, r, c)
            except (ValueError, OSError):
                pass

        signal.signal(signal.SIGUSR1, handle_resize)

        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()

        # Make stdin non-blocking
        fl = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
        fcntl.fcntl(stdin_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

        try:
            while True:
                rlist, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)

                if master_fd in rlist:
                    try:
                        data = os.read(master_fd, 16384)
                        if not data:
                            break
                        os.write(stdout_fd, data)
                    except OSError:
                        break

                if stdin_fd in rlist:
                    try:
                        data = os.read(stdin_fd, 16384)
                        if not data:
                            break
                        os.write(master_fd, data)
                    except OSError:
                        break
        except KeyboardInterrupt:
            pass
        finally:
            os.close(master_fd)
            _, status = os.waitpid(pid, 0)
            sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)


if __name__ == "__main__":
    main()
