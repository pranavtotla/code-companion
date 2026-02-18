import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoomManager, Room } from "../src/rooms.js";

describe("RoomManager", () => {
  let manager: RoomManager;

  beforeEach(() => {
    manager = new RoomManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  describe("createRoom", () => {
    it("creates a room with a 6-character code", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      expect(room.code).toHaveLength(6);
      expect(room.code).toMatch(/^[a-z0-9]+$/);
    });

    it("stores the room and retrieves it by code", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      const found = manager.getRoom(room.code);
      expect(found).toBe(room);
    });

    it("sets host display name when provided", () => {
      const room = manager.createRoom({ cwd: "/tmp", hostName: "Alice" });
      expect(room.hostName).toBe("Alice");
    });
  });

  describe("getRoom", () => {
    it("returns undefined for unknown codes", () => {
      expect(manager.getRoom("nope")).toBeUndefined();
    });
  });

  describe("Room", () => {
    it("tracks connected user count", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      expect(room.userCount).toBe(0);
    });

    it("allows unlimited users", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      for (let i = 0; i < 10; i++) {
        expect(room.addUser(`socket${i}`, `User${i}`)).toBe(true);
      }
      expect(room.userCount).toBe(10);
    });

    it("removes a user by socket ID", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      room.removeUser("socket1");
      expect(room.userCount).toBe(1);
    });

    it("returns user display name by socket ID", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      expect(room.getUserName("socket1")).toBe("Alice");
    });

    it("lists all connected users", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      expect(room.getUsers()).toEqual([
        { socketId: "socket1", name: "Alice" },
        { socketId: "socket2", name: "Bob" },
      ]);
    });
  });

  describe("destroyRoom", () => {
    it("removes the room from the manager", () => {
      const room = manager.createRoom({ cwd: "/tmp" });
      manager.destroyRoom(room.code);
      expect(manager.getRoom(room.code)).toBeUndefined();
    });
  });
});
