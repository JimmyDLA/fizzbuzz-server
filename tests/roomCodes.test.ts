import { ErrorCode, LocalDriver, LocalPresence, RoomInternalState, ServerError, initializeRoomCache, matchMaker } from "@colyseus/core";
import type { Client, Room } from "@colyseus/core";
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { PracticeRoom } from "../src/rooms/PracticeRoom";
import {
  ROOM_CODE_MAX,
  ROOM_CODE_MIN,
  claimRoomCode,
  clearReservedRoomCodesForTests,
  formatRoomCode,
  isCanonicalRoomCode,
  releaseRoomCode,
  reserveRoomCodeForTests,
  useRoomCodeDrawForTests,
  type RoomCodeLookup,
} from "../src/rooms/roomCodes";

/**
 * LOB-001: a host create returns a 4-digit code and that player is the room host.
 * LOB-009: concurrent rooms get distinct codes, and a code opens only its own room.
 */

const opened: Room[] = [];

class TrackingLobby extends LobbyRoom {
  constructor() {
    super();
    opened.push(this);
  }
}

function client(sessionId: string): Client {
  return { sessionId } as Client;
}

function clearSeatTimers(room: Room): void {
  const internal = room as unknown as {
    _reservedSeatTimeouts?: Record<string, NodeJS.Timeout>;
    _reservedSeats?: Record<string, unknown>;
    _autoDisposeTimeout?: NodeJS.Timeout;
  };
  for (const timeout of Object.values(internal._reservedSeatTimeouts ?? {})) {
    clearTimeout(timeout);
  }
  if (internal._reservedSeatTimeouts) {
    for (const sessionId of Object.keys(internal._reservedSeatTimeouts)) {
      delete internal._reservedSeatTimeouts[sessionId];
    }
  }
  if (internal._reservedSeats) {
    for (const sessionId of Object.keys(internal._reservedSeats)) {
      delete internal._reservedSeats[sessionId];
    }
  }
  if (internal._autoDisposeTimeout) {
    clearTimeout(internal._autoDisposeTimeout);
    internal._autoDisposeTimeout = undefined;
  }
}

async function disposeRoom(room: Room): Promise<void> {
  clearSeatTimers(room);
  const internal = room as unknown as { _internalState?: number };
  if (internal._internalState === RoomInternalState.DISPOSING) return;
  if (internal._internalState === RoomInternalState.CREATING) {
    internal._internalState = RoomInternalState.CREATED;
  }
  await room.disconnect();
  clearSeatTimers(room);
}

describe("room codes", { concurrency: 1 }, () => {
  afterEach(() => {
    clearReservedRoomCodesForTests();
    useRoomCodeDrawForTests(null);
  });

  describe("claimRoomCode", () => {
    it("stays inside 1000-9999 with no leading zero", async () => {
      assert.equal(formatRoomCode(0), "1000");
      assert.equal(formatRoomCode(1 - Number.EPSILON), "9999");
      assert.equal(isCanonicalRoomCode("0999"), false);
      assert.equal(isCanonicalRoomCode("999"), false);
      assert.equal(isCanonicalRoomCode("10000"), false);

      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const code = await claimRoomCode({ isLive: () => false });
        assert.equal(isCanonicalRoomCode(code), true);
        const value = Number(code);
        assert.ok(value >= ROOM_CODE_MIN && value <= ROOM_CODE_MAX);
        seen.add(code);
        releaseRoomCode(code);
      }
      assert.ok(seen.size > 1);
    });

    it("retries when the matchmaker already lists the drawn code", async () => {
      const live = new Set(["1000", "1001"]);
      useRoomCodeDrawForTests(() => "1000");
      const code = await claimRoomCode({ isLive: (candidate) => live.has(candidate) });
      assert.equal(code, "1002");
      assert.equal(live.has("1000"), true);
      assert.equal(live.has("1001"), true);
    });

    it("skips a code held by another room type in the same id space", async () => {
      const practiceRoomIds = new Set(["4242"]);
      useRoomCodeDrawForTests(() => "4242");
      const code = await claimRoomCode({
        isLive: (candidate) => practiceRoomIds.has(candidate),
      });
      assert.equal(code, "4243");
    });

    it("gives concurrent creators different codes when they draw the same one", async () => {
      let checks = 0;
      const lookup: RoomCodeLookup = {
        async isLive() {
          checks += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return false;
        },
      };
      useRoomCodeDrawForTests(() => "2500");
      const codes = await Promise.all([
        claimRoomCode(lookup),
        claimRoomCode(lookup),
        claimRoomCode(lookup),
      ]);
      assert.deepEqual([...codes].sort(), ["2500", "2501", "2502"]);
      assert.equal(new Set(codes).size, 3);
      assert.ok(checks >= 3);
    });

    it("reuses a code only after it is released and no longer listed", async () => {
      useRoomCodeDrawForTests(() => "5150");
      const listed = new Set<string>();
      const lookup: RoomCodeLookup = { isLive: (code) => listed.has(code) };

      const first = await claimRoomCode(lookup);
      assert.equal(first, "5150");
      listed.add(first);

      const whileReserved = await claimRoomCode({ isLive: () => false });
      assert.equal(whileReserved, "5151");

      releaseRoomCode(first);
      const stillListed = await claimRoomCode(lookup);
      assert.equal(stillListed, "5152");

      listed.delete(first);
      releaseRoomCode(stillListed);
      releaseRoomCode(whileReserved);
      const reused = await claimRoomCode(lookup);
      assert.equal(reused, "5150");
    });

    it("releases the claim when the matchmaker lookup fails", async () => {
      useRoomCodeDrawForTests(() => "1800");
      await assert.rejects(
        () => claimRoomCode({
          isLive() {
            throw new Error("driver down");
          },
        }),
        /driver down/,
      );
      const code = await claimRoomCode({ isLive: () => false });
      assert.equal(code, "1800");
    });

    it("fails cleanly when every code from 1000 to 9999 is already in use", async () => {
      useRoomCodeDrawForTests(() => "1000");
      await assert.rejects(
        () => claimRoomCode({ isLive: () => true }),
        (err: unknown) => {
          assert.ok(err instanceof ServerError);
          assert.equal(err.code, ErrorCode.MATCHMAKE_UNHANDLED);
          assert.match(err.message, /All codes from 1000 to 9999 are already in use/);
          return true;
        },
      );

      const code = await claimRoomCode({ isLive: () => false });
      assert.equal(code, "1000");
    });
  });

  describe("live lobby rooms", () => {
    before(async () => {
      await matchMaker.setup(new LocalPresence(), new LocalDriver());
      matchMaker.defineRoomType("lobby", TrackingLobby);
      matchMaker.defineRoomType("practice_room", PracticeRoom);
      await matchMaker.accept(true);
    });

    afterEach(async () => {
      const locals = new Set<Room>(opened);
      for (const listing of await matchMaker.query()) {
        const local = matchMaker.getLocalRoomById(listing.roomId);
        if (local) locals.add(local);
      }
      for (const room of locals) {
        await disposeRoom(room);
      }
      for (const listing of await matchMaker.query()) {
        matchMaker.driver.remove(listing.roomId);
      }
      opened.length = 0;
    });

    after(async () => {
      await matchMaker.gracefullyShutdown();
    });

    it("LOB-001 host create returns a 4-digit code and the first player is host", async () => {
      const seat = await matchMaker.create("lobby", { name: "Ada" });
      assert.equal(isCanonicalRoomCode(seat.roomId), true);
      assert.equal(seat.name, "lobby");

      const room = matchMaker.getLocalRoomById(seat.roomId) as LobbyRoom;
      room.onJoin(client(seat.sessionId), { name: "Ada" });
      const host = room.state.players.get(seat.sessionId);
      assert.equal(host?.isHost, true);
      assert.equal(host?.name, "Ada");
    });

    it("LOB-009 concurrent creates get distinct codes and joinById stays in that room", async () => {
      useRoomCodeDrawForTests(() => "7000");
      const names = ["Ann", "Bea", "Cal", "Dee", "Eve"];
      const seats = await Promise.all(names.map((name) => matchMaker.create("lobby", { name })));
      const codes = seats.map((seat) => seat.roomId);

      assert.deepEqual([...codes].sort(), ["7000", "7001", "7002", "7003", "7004"]);
      for (const code of codes) assert.equal(isCanonicalRoomCode(code), true);

      const hostSeat = seats[0];
      const otherSeat = seats[1];
      const joiner = await matchMaker.joinById(hostSeat.roomId, { name: "Zoe" });
      assert.equal(joiner.roomId, hostSeat.roomId);
      assert.notEqual(joiner.roomId, otherSeat.roomId);
      assert.equal(joiner.name, "lobby");

      const listings = await matchMaker.query({ roomId: hostSeat.roomId });
      assert.equal(listings.length, 1);
      assert.equal(listings[0].name, "lobby");

      const hostRoom = matchMaker.getLocalRoomById(hostSeat.roomId) as LobbyRoom;
      const otherRoom = matchMaker.getLocalRoomById(otherSeat.roomId) as LobbyRoom;
      assert.notEqual(hostRoom, otherRoom);

      hostRoom.onJoin(client(hostSeat.sessionId), { name: "Ann" });
      hostRoom.onJoin(client(joiner.sessionId), { name: "Zoe" });
      assert.equal(hostRoom.state.players.get(joiner.sessionId)?.name, "Zoe");
      assert.equal(hostRoom.state.players.get(hostSeat.sessionId)?.isHost, true);
      assert.equal(otherRoom.state.players.has(joiner.sessionId), false);
      assert.equal(otherRoom.state.players.has(hostSeat.sessionId), false);
    });

    it("treats a live practice_room id as taken in the shared matchmaker", async () => {
      const planted = initializeRoomCache({
        name: "practice_room",
        roomId: "4242",
        processId: matchMaker.processId,
      });
      matchMaker.driver.persist(planted, true);

      const practice = await matchMaker.create("practice_room", { category: "Tapping Race" });
      assert.equal(isCanonicalRoomCode(practice.roomId), false);

      useRoomCodeDrawForTests(() => "4242");
      const lobby = await matchMaker.create("lobby", { name: "Ada" });
      assert.equal(lobby.roomId, "4243");
      assert.notEqual(lobby.roomId, practice.roomId);

      const listed = await matchMaker.query();
      const byId = new Map(listed.map((room) => [room.roomId, room.name]));
      assert.equal(byId.get("4242"), "practice_room");
      assert.equal(byId.get(lobby.roomId), "lobby");
      assert.equal(byId.get(practice.roomId), "practice_room");

      const join = await matchMaker.joinById(lobby.roomId, { name: "Cal" });
      assert.equal(join.roomId, lobby.roomId);
      assert.equal((await matchMaker.query({ roomId: "4242" })).length, 1);
    });

    it("reuses a code after the room has fully closed", async () => {
      useRoomCodeDrawForTests(() => "5150");
      const first = await matchMaker.create("lobby", { name: "Ada" });
      assert.equal(first.roomId, "5150");

      const room = matchMaker.getLocalRoomById(first.roomId);
      assert.ok(room);
      await disposeRoom(room);
      assert.equal(await matchMaker.getRoomById("5150"), undefined);

      const second = await matchMaker.create("lobby", { name: "Bea" });
      assert.equal(second.roomId, "5150");
      const listings = await matchMaker.query({ roomId: "5150" });
      assert.equal(listings.length, 1);
    });

    it("create rejects with a host-visible error when the code space is exhausted", async () => {
      for (let n = ROOM_CODE_MIN; n <= ROOM_CODE_MAX; n++) {
        reserveRoomCodeForTests(String(n));
      }

      await assert.rejects(
        () => matchMaker.create("lobby", { name: "Ada" }),
        (err: unknown) => {
          assert.ok(err instanceof ServerError);
          assert.equal(err.code, ErrorCode.MATCHMAKE_UNHANDLED);
          assert.match(err.message, /All codes from 1000 to 9999 are already in use/);
          return true;
        },
      );

      assert.equal((await matchMaker.query()).length, 0);
    });
  });
});
