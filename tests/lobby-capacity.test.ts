import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ClientState, ErrorCode, Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LobbyRoom, RECONNECT_GRACE_SECONDS } from "../src/rooms/LobbyRoom";
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

function withDevWheel(fn: () => void): void {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.ALLOW_DEV_WHEEL;
  process.env.NODE_ENV = "test";
  process.env.ALLOW_DEV_WHEEL = "1";
  try {
    fn();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.ALLOW_DEV_WHEEL;
    else process.env.ALLOW_DEV_WHEEL = previousFlag;
  }
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
    assert.equal(room.state.phase, "chart");
    assert.equal(host.sent.filter((entry) => entry.type === LOBBY_ERROR_EVENT).length, 1);

    withDevWheel(() => {
      emit(room, "dev_start_wheel", host, { type: "BR", category: "Tapping Race", selectedPlayers: ["host"] });
    });

    assert.equal(room.state.phase, "chart");
    assert.notEqual(room.state.currentGameType, "BR");
    assert.equal(room.state.selectedPlayers.length, 0);
    assert.equal(host.sent.filter((entry) => entry.type === LOBBY_ERROR_EVENT).length, 2);
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
    assert.equal(lobbyError(host), undefined);

    withDevWheel(() => {
      emit(room, "dev_start_wheel", host, {
        type: "BR",
        category: "Tapping Race",
        selectedPlayers: ["host", "guest"],
      });
    });
    assert.equal(room.state.phase, "chart");
    assert.notEqual(room.state.currentGameType, "BR");
    assert.equal(room.state.selectedPlayers.length, 0);
    assert.deepEqual(lobbyError(host), notEnoughPlayersError());
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
    const listings = await matchMaker.query();
    for (const listing of listings) {
      const room = matchMaker.getLocalRoomById(listing.roomId) as LobbyRoom | undefined;
      if (!room) continue;
      const { pending, timers } = graceHandles(room);
      for (const entry of Object.values(pending)) entry[1].reject(false);
      for (const timer of Object.values(timers)) clearTimeout(timer);
    }
    await delay(50);
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

  it("holds a grace seat against a 13th join, then frees it when grace expires", async () => {
    assert.equal(RECONNECT_GRACE_SECONDS, 120);
    const filled = await fillLobby(port, post);
    try {
      const dropped = filled.sockets[0];
      const droppedId = filled.seats[0].sessionId as string;
      dropped.close(1000);

      await waitFor(() => filled.room.state.players.get(droppedId)?.isConnected === false
        && filled.room.state.players.has(droppedId)
        && filled.room.isAtSeatCapacity());

      const rejected = await post(`/matchmake/joinById/${filled.roomId}`, { name: "Player 13" });
      assert.equal(rejected.status, ErrorCode.MATCHMAKE_INVALID_ROOM_ID);
      assert.equal(rejected.json.error, formatLobbyError(roomFullError()));
      assert.equal(filled.room.state.players.size, MAX_ROOM_PLAYERS);
      const graceTimer = (filled.room as unknown as {
        _reservedSeatTimeouts?: Record<string, { _idleTimeout?: number }>;
      })._reservedSeatTimeouts?.[droppedId];
      assert.equal(graceTimer?._idleTimeout, RECONNECT_GRACE_SECONDS * 1000);
      expireGrace(filled.room, droppedId);

      const listing = await matchMaker.getRoomById(filled.roomId);
      await waitFor(() => !filled.room.state.players.has(droppedId)
        && !filled.room.isAtSeatCapacity()
        && listing.locked !== true, 5000);
      assert.equal(listing.locked, false);

      const joined = await post(`/matchmake/joinById/${filled.roomId}`, { name: "Player 13" });
      assert.equal(joined.status, 200, JSON.stringify(joined.json));
      assert.equal(filled.room.isAtSeatCapacity(), true);
    } finally {
      await releaseLobby(filled);
    }
  });

  it("lets the grace player reconnect into a room that rejects a 13th join", async () => {
    const filled = await fillLobby(port, post);
    try {
      const droppedSeat = filled.seats[0];
      const droppedId = String(droppedSeat.sessionId);
      const droppedClient = filled.room.clients.find((client) => client.sessionId === droppedId);
      const token = (droppedClient as { reconnectionToken?: string } | undefined)?.reconnectionToken;
      assert.equal(typeof token, "string");
      filled.sockets[0].close(1000);

      await waitFor(() => filled.room.state.players.get(droppedId)?.isConnected === false
        && filled.room.isAtSeatCapacity());

      const rejected = await post(`/matchmake/joinById/${filled.roomId}`, { name: "Player 13" });
      assert.equal(rejected.json.error, formatLobbyError(roomFullError()));

      const reconnect = await post(`/matchmake/reconnect/${filled.roomId}`, { reconnectionToken: token });
      assert.equal(reconnect.status, 200, JSON.stringify(reconnect.json));
      assert.equal(reconnect.json.sessionId, droppedId);

      const socket = await openSocket(port, {
        processId: String(reconnect.json.processId ?? droppedSeat.processId),
        roomId: filled.roomId,
        sessionId: droppedId,
        reconnectionToken: token,
      }, filled.room);
      filled.sockets.push(socket);

      await waitFor(() => filled.room.state.players.get(droppedId)?.isConnected === true);
      const stillFull = await post(`/matchmake/joinById/${filled.roomId}`, { name: "Player 13" });
      assert.equal(stillFull.json.error, formatLobbyError(roomFullError()));
      assert.equal(filled.room.state.players.has(droppedId), true);
    } finally {
      await releaseLobby(filled);
    }
  });

  it("frees the seat immediately when the leave is consented", async () => {
    const filled = await fillLobby(port, post);
    try {
      const droppedId = String(filled.seats[0].sessionId);
      filled.sockets[0].close(4000);

      await waitFor(() => !filled.room.state.players.has(droppedId) && !filled.room.isAtSeatCapacity());
      const joined = await post(`/matchmake/joinById/${filled.roomId}`, { name: "Player 13" });
      assert.equal(joined.status, 200, JSON.stringify(joined.json));
    } finally {
      await releaseLobby(filled);
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("timed out waiting for lobby seat change");
}

interface SeatReservation {
  processId?: unknown;
  roomId?: unknown;
  sessionId?: unknown;
}

interface FilledLobby {
  roomId: string;
  room: LobbyRoom;
  seats: SeatReservation[];
  sockets: WebSocket[];
}

async function fillLobby(
  port: number,
  post: (path: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>,
): Promise<FilledLobby> {
  const created = await post("/matchmake/create/lobby", { name: "Player 1" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const roomId = String(created.json.roomId);
  const seats: SeatReservation[] = [created.json];
  for (let index = 2; index <= MAX_ROOM_PLAYERS; index++) {
    const joined = await post(`/matchmake/joinById/${roomId}`, { name: `Player ${index}` });
    assert.equal(joined.status, 200, JSON.stringify(joined.json));
    seats.push(joined.json);
  }
  const room = () => matchMaker.getLocalRoomById(roomId) as LobbyRoom;
  const sockets: WebSocket[] = [];
  for (const seat of seats) {
    sockets.push(await openSocket(port, {
      processId: String(seat.processId),
      roomId,
      sessionId: String(seat.sessionId),
    }, room()));
  }
  await waitFor(() => room().state.players.size === MAX_ROOM_PLAYERS && room().clients.length === MAX_ROOM_PLAYERS);
  return { roomId, room: room(), seats, sockets };
}

async function openSocket(
  port: number,
  seat: { processId: string; roomId: string; sessionId: string; reconnectionToken?: string },
  room: LobbyRoom,
): Promise<WebSocket> {
  const token = seat.reconnectionToken ? `&reconnectionToken=${encodeURIComponent(seat.reconnectionToken)}` : "";
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/${seat.processId}/${seat.roomId}?sessionId=${seat.sessionId}${token}`,
  );
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    const bytes = Buffer.from(event.data as ArrayBuffer);
    if (bytes[0] === 10) ws.send(Buffer.from([10]));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`socket failed for ${seat.sessionId}`)));
  });
  await waitFor(() => {
    const client = room.clients.find((entry) => entry.sessionId === seat.sessionId);
    return client?.state === ClientState.JOINED && room.state.players.has(seat.sessionId);
  });
  return ws;
}

function graceHandles(room: LobbyRoom): {
  pending: Record<string, [string, { reject: (value: boolean) => void }]>;
  timers: Record<string, ReturnType<typeof setTimeout>>;
} {
  const internal = room as unknown as {
    _reconnections?: Record<string, [string, { reject: (value: boolean) => void }]>;
    _reservedSeatTimeouts?: Record<string, ReturnType<typeof setTimeout>>;
  };
  return {
    pending: internal._reconnections ?? {},
    timers: internal._reservedSeatTimeouts ?? {},
  };
}

function expireGrace(room: LobbyRoom, sessionId: string): void {
  const { pending, timers } = graceHandles(room);
  const timer = timers[sessionId];
  const match = Object.values(pending).find((entry) => entry[0] === sessionId);
  assert.ok(match, "grace reservation was not armed");
  match[1].reject(false);
  if (timer) clearTimeout(timer);
}

async function releaseLobby(filled: FilledLobby): Promise<void> {
  const { pending, timers } = graceHandles(filled.room);
  for (const entry of Object.values(pending)) entry[1].reject(false);
  for (const timer of Object.values(timers)) clearTimeout(timer);
  for (const socket of filled.sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(4000);
    }
  }
  await delay(100);
}
