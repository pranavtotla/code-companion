import { customAlphabet } from "nanoid";

const generateCode = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

interface UserInfo {
  socketId: string;
  name: string;
}

interface CreateRoomOptions {
  cwd: string;
  hostName?: string;
}

const MAX_USERS = 2;

export class Room {
  readonly code: string;
  readonly cwd: string;
  readonly hostName: string;
  private users: Map<string, string> = new Map(); // socketId -> displayName

  constructor(code: string, options: CreateRoomOptions) {
    this.code = code;
    this.cwd = options.cwd;
    this.hostName = options.hostName ?? "Host";
  }

  get userCount(): number {
    return this.users.size;
  }

  addUser(socketId: string, name: string): boolean {
    if (this.users.size >= MAX_USERS) return false;
    this.users.set(socketId, name);
    return true;
  }

  removeUser(socketId: string): void {
    this.users.delete(socketId);
  }

  getUserName(socketId: string): string | undefined {
    return this.users.get(socketId);
  }

  getUsers(): UserInfo[] {
    return Array.from(this.users.entries()).map(([socketId, name]) => ({
      socketId,
      name,
    }));
  }

  destroy(): void {
    this.users.clear();
  }
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();

  createRoom(options: CreateRoomOptions): Room {
    const code = generateCode();
    const room = new Room(code, options);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  destroyRoom(code: string): void {
    const room = this.rooms.get(code);
    if (room) {
      room.destroy();
      this.rooms.delete(code);
    }
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
  }
}
