import { customAlphabet } from "nanoid";

const generateCode = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

interface UserInfo {
  socketId: string;
  name: string;
}

export class Room {
  readonly code: string;
  creatorSocketId: string | null = null;
  private users: Map<string, string> = new Map(); // socketId -> displayName

  constructor(code: string) {
    this.code = code;
  }

  get userCount(): number {
    return this.users.size;
  }

  addUser(socketId: string, name: string): void {
    if (this.creatorSocketId === null) {
      this.creatorSocketId = socketId;
    }
    this.users.set(socketId, name);
  }

  removeUser(socketId: string): void {
    this.users.delete(socketId);
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

  createRoom(): Room {
    const code = generateCode();
    const room = new Room(code);
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
