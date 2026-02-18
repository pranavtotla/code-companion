import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
      const room = manager.createRoom();
      expect(room.code).toHaveLength(6);
      expect(room.code).toMatch(/^[a-z0-9]+$/);
    });

    it("stores the room and retrieves it by code", () => {
      const room = manager.createRoom();
      const found = manager.getRoom(room.code);
      expect(found).toBe(room);
    });

});

  describe("getRoom", () => {
    it("returns undefined for unknown codes", () => {
      expect(manager.getRoom("nope")).toBeUndefined();
    });
  });

  describe("Room", () => {
    it("tracks connected user count", () => {
      const room = manager.createRoom();
      expect(room.userCount).toBe(0);
    });

    it("allows unlimited users", () => {
      const room = manager.createRoom();
      for (let i = 0; i < 10; i++) {
        room.addUser(`socket${i}`, `User${i}`);
      }
      expect(room.userCount).toBe(10);
    });

    it("removes a user by socket ID", () => {
      const room = manager.createRoom();
      room.addUser("socket1", "Alice");
      room.addUser("socket2", "Bob");
      room.removeUser("socket1");
      expect(room.userCount).toBe(1);
    });

    it("lists all connected users", () => {
      const room = manager.createRoom();
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
      const room = manager.createRoom();
      manager.destroyRoom(room.code);
      expect(manager.getRoom(room.code)).toBeUndefined();
    });
  });
});
