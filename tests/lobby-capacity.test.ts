import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ErrorCode, Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { PracticeRoom } from "../src/rooms/PracticeRoom";
import {
  MAX_ROOM_PLAYERS,
  MIN_CONNECTED_PLAYERS,
  hasEnoughConnectedPlayers,
} from "../src/rooms/connectedPlayers";
import {
  LOBBY_ERROR_EVENT,
  formatLobbyError,
  notEnoughPlayersError,
  parseLobbyError,
  roomFullError,
} from "../src/rooms/lobbyErrors";
import { Player } from "../src/rooms/schema/LobbyState";

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  sent: SentMessage[];
  send(type: string, payload: unknown): void;
  enqueueRaw(): void;
}

function bootRoom(): LobbyRoom {
  const room = new LobbyRoom();
  room.onCreate({});
  room.broadcast = (() => undefined) as LobbyRoom["broadcast"];
  return room;
}

function addPlayer(
  room: LobbyRoom,
  id: string,
  options: { name?: string; ready?: boolean; host?: boolean; connected?: boolean } = {},
): FakeClient {
  const connected = options.connected !== false;
  const player = new Player();
  player.id = id;
  player.name = options.name ?? id;
  player.isReady = options.ready ?? false;
  player.isHost = options.host ?? false;
  player.isConnected = connected;
  room.state.players.set(id, player);

  const client: FakeClient = {
    sessionId: id,
    sent: [],
    send(type, payload) {
      this.sent.push({ type, payload });
    },
    enqueueRaw() {},
  };
  if (connected) {
    room.clients.push(client as unknown as LobbyRoom["clients"][number]);
  }
  return client;
}

function emit(room: LobbyRoom, type: string, client: FakeClient, message?: unknown): void {
  const events = (room as unknown as {
    onMessageEvents: { emit: (event: string, ...args: unknown[]) => void };
  }).onMessageEvents;
  events.emit(type, client, message);
}

function lobbyError(client: FakeClient) {
  return client.sent.find((entry) => entry.type === LOBBY_ERROR_EVENT)?.payload;
}

describe("connected player start gate", () => {
  it("counts only connected players and requires two of them", () => {
    const players = {
      forEach(callback: (player: { isConnected: boolean }, sessionId: string) => void) {
        callback({ isConnected: true }, "a");
        callback({ isConnected: false }, "b");
      },
    };
    assert.equal(MIN_CONNECTED_PLAYERS, 2);
    assert.equal(hasEnoughConnectedPlayers(players), false);
    assert.equal(hasEnoughConnectedPlayers({
      forEach(callback: (player: { isConnected: boolean }, sessionId: string) => void) {
        callback({ isConnected: true }, "a");
        callback({ isConnected: true }, "b");
        callback({ isConnected: false }, "cached");
      },
    }), true);
  });

  it("formats join and start errors so the app can branch on a stable code", () => {
    const full = roomFullError();
    const blocked = notEnoughPlayersError();
    assert.equal(full.code, "ROOM_FULL");
    assert.equal(blocked.code, "NOT_ENOUGH_PLAYERS");
    assert.match(full.message, /full/i);
    assert.match(blocked.message, /2 players/i);
    assert.deepEqual(parseLobbyError(formatLobbyError(full)), full);
    assert.deepEqual(parseLobbyError(formatLobbyError(blocked)), blocked);
  });
});

describe("lobby start minimum", () => {
  it("LOB-006: a solo host who readies stays in the lobby and is told why", () => {
    const room = bootRoom();
    const host = addPlayer(room, "host", { name: "Ada", host: true });

    emit(room, "ready", host, { isReady: true });

    assert.equal(room.state.phase, "lobby");
    assert.equal(room.state.players.get("host")?.isReady, true);
    assert.deepEqual(lobbyError(host), notEnoughPlayersError());
    assert.equal(room.state.currentGameType, "");
    assert.equal(room.state.selectedPlayers.length, 0);

    assert.equal(room.startWheelPhase(), false);
    assert.equal(room.state.phase, "lobby");
    assert.notEqual(room.state.currentGameType, "BR");

    room.state.phase = "chart";
    emit(room, "start_wheel", host);
    emit(room, "dev_start_wheel", host, { type: "BR", category: "Tapping Race", selectedPlayers: ["host"] });

    assert.equal(room.state.phase, "chart");
    assert.notEqual(room.state.currentGameType, "BR");
    assert.equal(room.state.selectedPlayers.length, 0);
    assert.equal(host.sent.filter((entry) => entry.type === LOBBY_ERROR_EVENT).length, 3);
  });

  it("LOB-006: one connected player plus a cached reconnect seat cannot start", () => {
    const room = bootRoom();
    const host = addPlayer(room, "host", { name: "Ada", host: true, ready: true });
    addPlayer(room, "ghost", { name: "Bea", connected: false, ready: true });

    room.checkAllReady();
    emit(room, "ready", host, { isReady: true });

    assert.equal(room.state.phase, "lobby");
    assert.equal(room.startWheelPhase(), false);
    assert.equal(room.state.phase, "lobby");
    assert.notEqual(room.state.currentGameType, "BR");
    assert.deepEqual(room.state.selectedPlayers.toArray(), []);
  });

  it("does not warn when two players are seated and someone is still not ready", () => {
    const room = bootRoom();
    const host = addPlayer(room, "host", { name: "Ada", host: true });
    addPlayer(room, "guest", { name: "Bea" });

    emit(room, "ready", host, { isReady: true });

    assert.equal(room.state.phase, "lobby");
    assert.equal(lobbyError(host), undefined);
  });

  for (const size of [2, 3, 6, 11, 12]) {
    it(`LOB-012${size === 12 ? " / LOB-008" : ""}: ${size} ready players reach chart and wheel`, () => {
      const room = bootRoom();
      const clients: FakeClient[] = [];
      for (let index = 0; index < size; index++) {
        clients.push(addPlayer(room, `p${index}`, {
          name: `Player ${index}`,
          host: index === 0,
        }));
      }

      for (const client of clients) {
        emit(room, "ready", client, { isReady: true });
        assert.equal(lobbyError(client), undefined);
      }

      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.players.get("p0")?.isReady, false);

      assert.equal(room.startWheelPhase(), true);
      assert.equal(room.state.phase, "wheel");
      assert.notEqual(room.state.phase, "playing");
      const selected = room.state.selectedPlayers.toArray();
      assert.ok(selected.length >= MIN_CONNECTED_PLAYERS);
      assert.ok(selected.length <= size);
      for (const id of selected) {
        assert.equal(room.state.players.get(id)?.isConnected, true);
      }
      if (room.state.currentGameType === "BR") {
        assert.ok(selected.length >= MIN_CONNECTED_PLAYERS);
      }
    });
  }

  it("leaves disconnected players out of the wheel", () => {
    const room = bootRoom();
    const host = addPlayer(room, "host", { name: "Ada", host: true });
    const guest = addPlayer(room, "guest", { name: "Bea" });
    addPlayer(room, "ghost", { name: "Cal", connected: false });

    emit(room, "ready", host, { isReady: true });
    emit(room, "ready", guest, { isReady: true });
    assert.equal(room.state.phase, "chart");

    assert.equal(room.startWheelPhase(), true);
    assert.deepEqual(room.state.selectedPlayers.toArray().sort(), ["guest", "host"]);
    assert.equal(room.forceWheelPhase("BR", "Trivia", ["host", "ghost", "guest"]), true);
    assert.deepEqual(room.state.selectedPlayers.toArray(), ["host", "guest"]);
    assert.equal(room.state.phase, "wheel");
  });

  it("refuses the host dev start after the room drops below two connected players", () => {
    const room = bootRoom();
    const host = addPlayer(room, "host", { name: "Ada", host: true, ready: true });
    addPlayer(room, "guest", { name: "Bea", ready: true });
    room.checkAllReady();
    assert.equal(room.state.phase, "chart");

    const guestPlayer = room.state.players.get("guest");
    assert.ok(guestPlayer);
    guestPlayer.isConnected = false;
    const guestIndex = room.clients.findIndex((client) => client.sessionId === "guest");
    if (guestIndex >= 0) room.clients.splice(guestIndex, 1);

    emit(room, "start_wheel", host);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.currentGameType, "");
    assert.deepEqual(lobbyError(host), notEnoughPlayersError());

    emit(room, "dev_start_wheel", host, {
      type: "BR",
      category: "Tapping Race",
      selectedPlayers: ["host", "guest"],
    });
    assert.equal(room.state.phase, "chart");
    assert.notEqual(room.state.currentGameType, "BR");
    assert.equal(room.state.selectedPlayers.length, 0);
  });
});

describe("LOB-005 room cap", () => {
  let server: Server;
  let port = 0;

  before(async () => {
    server = new Server({
      greet: false,
      gracefullyShutdown: false,
      transport: new WebSocketTransport({ pingInterval: 0 }),
    });
    server.define("lobby", LobbyRoom);
    server.define("practice_room", PracticeRoom);
    await server.listen(0);
    const address = server.transport.server?.address();
    assert.ok(address && typeof address === "object");
    port = address.port;
  });

  after(async () => {
    await server.gracefullyShutdown(false);
  });

  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json() as Record<string, unknown>;
    return { status: response.status, json };
  }

  it("rejects a 13th join by room code and leaves the 12 seats reserved", async () => {
    assert.equal(new LobbyRoom().maxClients, 12);
    assert.equal(new LobbyRoom().maxClients, MAX_ROOM_PLAYERS);

    const created = await post("/matchmake/create/lobby", { name: "Player 1" });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const roomId = created.json.roomId;
    assert.equal(typeof roomId, "string");
    const seats = [created.json];

    for (let index = 2; index <= MAX_ROOM_PLAYERS; index++) {
      const joined = await post(`/matchmake/joinById/${roomId}`, { name: `Player ${index}` });
      assert.equal(joined.status, 200, JSON.stringify(joined.json));
      seats.push(joined.json);
    }

    const rejected = await post(`/matchmake/joinById/${roomId}`, { name: "Player 13" });
    assert.equal(rejected.status, ErrorCode.MATCHMAKE_INVALID_ROOM_ID);
    assert.equal(rejected.json.code, ErrorCode.MATCHMAKE_INVALID_ROOM_ID);
    assert.equal(rejected.json.error, formatLobbyError(roomFullError()));
    assert.deepEqual(parseLobbyError(String(rejected.json.error)), roomFullError());

    const listing = await matchMaker.getRoomById(String(roomId));
    assert.equal(listing.clients, MAX_ROOM_PLAYERS);
    assert.equal(listing.maxClients, MAX_ROOM_PLAYERS);
    assert.equal(listing.locked, true);

    const live = matchMaker.getLocalRoomById(String(roomId)) as LobbyRoom;
    assert.equal(live.maxClients, MAX_ROOM_PLAYERS);
    for (const seat of seats) {
      assert.equal(live.hasReservedSeat(String(seat.sessionId)), true);
    }

    const practice = await post("/matchmake/create/practice_room", { category: "Tapping Race" });
    assert.equal(practice.status, 200, JSON.stringify(practice.json));
    const practiceFull = await post(`/matchmake/joinById/${practice.json.roomId}`, { name: "Second" });
    assert.notEqual(practiceFull.status, 200);
    assert.equal(parseLobbyError(String(practiceFull.json.error ?? "")), null);
  });
});
