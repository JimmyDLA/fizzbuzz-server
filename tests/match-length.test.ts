import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CloseCode, ErrorCode, Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { Client } from "@colyseus/core";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import {
  LOBBY_ERROR_EVENT,
  invalidRoundsError,
  notHostError,
  roundsLockedError,
} from "../src/rooms/lobbyErrors";
import {
  GAME_OVER_EVENT,
  ROUND_CHOICES,
  SET_ROUNDS_MESSAGE,
  buildPodium,
  upcomingRoundNumber,
} from "../src/rooms/matchLength";
import { Player } from "../src/rooms/schema/LobbyState";

interface SentMessage {
  type: string;
  payload: unknown;
}

interface Broadcast {
  type: string;
  payload: unknown;
  phase: string;
  podiumLength: number;
}

interface FakeClient {
  sessionId: string;
  sent: SentMessage[];
  send(type: string, payload: unknown): void;
  enqueueRaw(): void;
}

interface CloseSpy {
  count: number;
  phase: string;
  podiumLength: number;
}

function bootRoom(): { room: LobbyRoom; broadcasts: Broadcast[]; closed: CloseSpy; timeline: string[] } {
  const room = new LobbyRoom();
  room.onCreate({});
  const broadcasts: Broadcast[] = [];
  const timeline: string[] = [];
  const patch = room.broadcastPatch.bind(room);
  room.broadcastPatch = (() => {
    timeline.push(`patch:${room.state.phase}:${room.state.podium.length}`);
    return patch();
  }) as LobbyRoom["broadcastPatch"];
  room.broadcast = ((type: string, payload?: unknown) => {
    if (type === GAME_OVER_EVENT) {
      timeline.push(`event:${room.state.phase}:${room.state.podium.length}`);
    }
    broadcasts.push({
      type,
      payload,
      phase: room.state.phase,
      podiumLength: room.state.podium.length,
    });
  }) as LobbyRoom["broadcast"];
  const closed: CloseSpy = { count: 0, phase: "", podiumLength: -1 };
  room.disconnect = (() => {
    closed.count += 1;
    closed.phase = room.state.phase;
    closed.podiumLength = room.state.podium.length;
    timeline.push(`close:${room.state.phase}:${room.state.podium.length}`);
    return Promise.resolve();
  }) as LobbyRoom["disconnect"];
  return { room, broadcasts, closed, timeline };
}

function addPlayer(
  room: LobbyRoom,
  id: string,
  options: { name?: string; host?: boolean; score?: number; drinks?: number } = {},
): FakeClient {
  const player = new Player();
  player.id = id;
  player.name = options.name ?? id;
  player.isHost = options.host ?? false;
  player.isConnected = true;
  player.score = options.score ?? 0;
  player.drinks = options.drinks ?? 0;
  room.state.players.set(id, player);

  const client: FakeClient = {
    sessionId: id,
    sent: [],
    send(type, payload) {
      this.sent.push({ type, payload });
    },
    enqueueRaw() {},
  };
  room.clients.push(client as unknown as LobbyRoom["clients"][number]);
  return client;
}

function emit(room: LobbyRoom, type: string, client: FakeClient, message?: unknown): void {
  const events = (room as unknown as {
    onMessageEvents: { emit: (event: string, ...args: unknown[]) => void };
  }).onMessageEvents;
  events.emit(type, client, message);
}

function ready(room: LobbyRoom, client: FakeClient, isReady = true): void {
  emit(room, "ready", client, { isReady });
}

function lobbyError(client: FakeClient) {
  const errors = client.sent.filter((entry) => entry.type === LOBBY_ERROR_EVENT);
  return errors[errors.length - 1]?.payload;
}

function setRounds(room: LobbyRoom, client: FakeClient, rounds: unknown): void {
  emit(room, SET_ROUNDS_MESSAGE, client, { rounds });
}

function seat(
  ids: string[],
  options: { scores?: Record<string, number>; drinks?: Record<string, number>; totalRounds?: number } = {},
) {
  const { room, broadcasts, closed, timeline } = bootRoom();
  const clients = ids.map((id, index) => addPlayer(room, id, {
    name: id,
    host: index === 0,
    score: options.scores?.[id] ?? 0,
    drinks: options.drinks?.[id] ?? 0,
  }));
  if (options.totalRounds !== undefined) {
    room.state.totalRounds = options.totalRounds;
  }
  return { room, broadcasts, closed, clients, timeline };
}

function enterChart(room: LobbyRoom, clients: FakeClient[]): void {
  for (const client of clients) ready(room, client);
  assert.equal(room.state.phase, "chart");
}

function spin(room: LobbyRoom, clients: FakeClient[]): void {
  assert.equal(room.state.phase, "chart");
  for (const client of clients) {
    const player = room.state.players.get(client.sessionId);
    if (player?.isConnected) ready(room, client);
  }
  assert.equal(room.state.phase, "wheel");
}

/** Contestants ready out of a resolution that has already started. */
function readyOutOfResolution(room: LobbyRoom, clients: FakeClient[]): void {
  assert.equal(room.state.phase, "resolution");
  const selected = room.state.selectedPlayers.toArray();
  for (const id of selected) {
    const player = room.state.players.get(id);
    if (!player?.isConnected) continue;
    const client = clients.find((entry) => entry.sessionId === id);
    assert.ok(client, `selected player ${id} has a client`);
    ready(room, client);
    if (room.state.phase !== "resolution") return;
  }
}

function playRounds(room: LobbyRoom, clients: FakeClient[], count: number, onChart?: (roundCount: number) => void): void {
  for (let offset = 0; offset < count; offset += 1) {
    const completed = room.state.roundCount;
    onChart?.(completed);
    spin(room, clients);
    assert.equal(room.state.roundCount, completed, "the wheel does not advance roundCount");
    room.startResolutionPhase();
    assert.equal(room.state.roundCount, completed + 1, "resolution start is the only increment");
    assert.equal(room.state.phase, "resolution");
    readyOutOfResolution(room, clients);
  }
}

function gameOvers(broadcasts: Broadcast[]): Broadcast[] {
  return broadcasts.filter((entry) => entry.type === GAME_OVER_EVENT);
}

function spins(broadcasts: Broadcast[]): Broadcast[] {
  return broadcasts.filter((entry) => entry.type === "SpinWheelEvent");
}

function connectedHostIds(room: LobbyRoom): string[] {
  const ids: string[] = [];
  room.state.players.forEach((player, id) => {
    if (player.isConnected && player.isHost) ids.push(id);
  });
  return ids;
}

function podiumFromState(room: LobbyRoom) {
  return room.state.podium.toArray().map((entry) => ({
    place: entry.place,
    playerId: entry.playerId,
    name: entry.name,
    score: entry.score,
  }));
}

/** Abnormal close. Only CloseCode.CONSENTED (4000) removes the seat immediately. */
function beginGrace(room: LobbyRoom, client: FakeClient): Promise<unknown> {
  (client as FakeClient & { reconnectionToken?: string }).reconnectionToken = `${client.sessionId}-grace`;
  return room.onLeave(client as unknown as Client, 1006);
}

async function finishGrace(
  room: LobbyRoom,
  client: FakeClient,
  pending: Promise<unknown>,
  reconnect = false,
): Promise<void> {
  const token = (client as FakeClient & { reconnectionToken?: string }).reconnectionToken ?? "";
  const internal = room as unknown as {
    _reconnections: Record<string, [string, { resolve: (value: unknown) => void; reject: (value: unknown) => void }]>;
    _reservedSeatTimeouts?: Record<string, ReturnType<typeof setTimeout>>;
    _autoDisposeTimeout?: ReturnType<typeof setTimeout>;
  };
  const timer = internal._reservedSeatTimeouts?.[client.sessionId];
  if (timer) clearTimeout(timer);
  const entry = internal._reconnections[token];
  assert.ok(entry, "grace reservation was not armed");
  if (reconnect) {
    entry[1].resolve({ sessionId: client.sessionId, reconnectionToken: token });
  } else {
    entry[1].reject(false);
  }
  await pending;
  if (internal._autoDisposeTimeout) clearTimeout(internal._autoDisposeTimeout);
}

function useManualTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let nextId = 1;
  const pending = new Map<number, () => void>();

  global.setTimeout = ((callback: TimerHandler) => {
    const id = nextId++;
    pending.set(id, () => {
      if (typeof callback === "function") callback();
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  global.clearTimeout = ((id: number) => {
    pending.delete(id);
  }) as unknown as typeof clearTimeout;

  return {
    flush() {
      const batch = [...pending.values()];
      pending.clear();
      for (const callback of batch) callback();
    },
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      pending.clear();
    },
  };
}

describe("match length", { concurrency: 1 }, () => {
  it("defaults to 10 rounds and a zero round counter", () => {
    const { room, closed } = bootRoom();
    assert.equal(room.state.totalRounds, 10);
    assert.equal(room.state.roundCount, 0);
    assert.equal(room.state.podium.length, 0);
    assert.equal(room.state.phase, "lobby");

    const host = addPlayer(room, "ada", { name: "Ada", host: true });
    ready(room, host);
    assert.equal(room.state.phase, "lobby");
    assert.equal(room.state.totalRounds, 10);
    assert.equal(room.state.roundCount, 0);
    assert.equal(closed.count, 0);
  });

  it("lets the host store each allowed length, including the default", () => {
    const { room, clients } = seat(["ada", "bea"]);
    const host = clients[0];
    for (const rounds of ROUND_CHOICES) {
      setRounds(room, host, rounds);
      assert.equal(room.state.totalRounds, rounds);
      assert.equal(lobbyError(host), undefined);
    }
    assert.deepEqual([...ROUND_CHOICES], [10, 15, 20, 30, 40, 50]);
  });

  it("rejects a non-host and an invalid length without changing the stored value", () => {
    const { room, clients } = seat(["ada", "bea"]);
    const host = clients[0];
    const guest = clients[1];

    setRounds(room, guest, 20);
    assert.equal(room.state.totalRounds, 10);
    assert.deepEqual(lobbyError(guest), notHostError());

    const rejected: unknown[] = [
      0, 1, 5, 9, 11, 12, 25, 35, 45, 60, 100, -10, 10.5,
      Number.NaN, Number.POSITIVE_INFINITY, "10", "20", null, undefined, true, {}, [],
    ];
    for (const rounds of rejected) {
      setRounds(room, host, rounds);
      assert.equal(room.state.totalRounds, 10, `rejected ${String(rounds)}`);
      assert.deepEqual(lobbyError(host), invalidRoundsError());
    }

    setRounds(room, host, undefined);
    emit(room, SET_ROUNDS_MESSAGE, host, {});
    emit(room, SET_ROUNDS_MESSAGE, host, undefined);
    assert.equal(room.state.totalRounds, 10);

    setRounds(room, host, 30);
    assert.equal(room.state.totalRounds, 30);
    setRounds(room, guest, 50);
    assert.equal(room.state.totalRounds, 30);
    assert.deepEqual(lobbyError(guest), notHostError());
  });

  it("rejects set_rounds from a former host after they reconnect", async () => {
    const { room, clients } = seat(["ada", "bea"]);
    const former = clients[0];
    const guest = clients[1];
    assert.equal(room.state.players.get("ada")?.isHost, true);
    assert.equal(room.state.players.get("bea")?.isHost, false);

    const pending = beginGrace(room, former);
    assert.equal(room.state.players.get("ada")?.isConnected, false);
    assert.equal(room.state.players.get("ada")?.isHost, false);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    assert.equal(room.state.phase, "lobby");

    await finishGrace(room, former, pending, true);

    assert.equal(room.state.players.get("ada")?.isConnected, true);
    assert.equal(room.state.players.get("ada")?.isHost, false);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    assert.equal(room.state.phase, "lobby");

    setRounds(room, former, 20);
    assert.equal(room.state.totalRounds, 10);
    assert.deepEqual(lobbyError(former), notHostError());

    setRounds(room, guest, 30);
    assert.equal(room.state.totalRounds, 30);
    assert.equal(lobbyError(guest), undefined);

    const ada = room.state.players.get("ada");
    assert.ok(ada);
    ada.isHost = true;
    setRounds(room, former, 40);
    setRounds(room, guest, 50);
    assert.equal(room.state.totalRounds, 30);
    assert.deepEqual(lobbyError(former), notHostError());
    assert.deepEqual(lobbyError(guest), notHostError());
  });

  it("locks the length once the room leaves the lobby and keeps it for a late joiner", () => {
    const { room, clients } = seat(["ada", "bea"]);
    const host = clients[0];
    setRounds(room, host, 40);
    enterChart(room, clients);
    assert.equal(room.state.roundCount, 0);
    assert.equal(room.state.totalRounds, 40);

    setRounds(room, host, 50);
    assert.equal(room.state.totalRounds, 40);
    assert.deepEqual(lobbyError(host), roundsLockedError());

    setRounds(room, clients[1], 20);
    assert.equal(room.state.totalRounds, 40);
    assert.deepEqual(lobbyError(clients[1]), notHostError());

    const cal: FakeClient = {
      sessionId: "cal",
      sent: [],
      send(type, payload) {
        this.sent.push({ type, payload });
      },
      enqueueRaw() {},
    };
    room.clients.push(cal as unknown as LobbyRoom["clients"][number]);
    room.onJoin(cal as unknown as Client, { name: "Cal" });
    assert.equal(room.state.totalRounds, 40);
    assert.equal(room.state.roundCount, 0);
    assert.equal(room.state.phase, "chart");
  });

  it("has no end-match message", () => {
    const { room, clients, closed, broadcasts } = seat(["ada", "bea"]);
    enterChart(room, clients);
    for (const type of ["end_match", "end_early", "endMatch"]) {
      emit(room, type, clients[0], {});
      emit(room, type, clients[1], { rounds: 10 });
    }
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 0);
    assert.equal(closed.count, 0);
    assert.equal(gameOvers(broadcasts).length, 0);
    assert.equal(spins(broadcasts).length, 0);
  });
});

describe("round counter", { concurrency: 1 }, () => {
  it("increments roundCount only when resolution starts", () => {
    const { room, clients, broadcasts } = seat(["ada", "bea"]);
    assert.equal(room.state.roundCount, 0);
    enterChart(room, clients);
    assert.equal(room.state.roundCount, 0);
    assert.equal(upcomingRoundNumber(room.state.roundCount), 1);

    spin(room, clients);
    assert.equal(room.state.phase, "wheel");
    assert.equal(room.state.roundCount, 0);
    assert.equal(spins(broadcasts).length, 1);
    room.checkAllReady();
    assert.equal(room.state.roundCount, 0);

    room.state.phase = "countdown";
    assert.equal(room.state.roundCount, 0);
    room.state.phase = "playing";
    assert.equal(room.state.roundCount, 0);

    room.startResolutionPhase();
    assert.equal(room.state.phase, "resolution");
    assert.equal(room.state.roundCount, 1);
    readyOutOfResolution(room, clients);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 1);
    assert.equal(upcomingRoundNumber(room.state.roundCount), 2);

    spin(room, clients);
    assert.equal(room.state.roundCount, 1);
    room.startResolutionPhase();
    assert.equal(room.state.roundCount, 2);
    assert.equal(room.state.phase, "resolution");
  });

  it("does not advance when a respin or a wild card replaces the wheel", () => {
    const timers = useManualTimers();
    const { room, clients } = seat(["ada", "bea", "cal"]);
    try {
      enterChart(room, clients);
      const ada = room.state.players.get("ada");
      assert.ok(ada);
      ada.cards.push("RESPIN");
      emit(room, "use_card", clients[0], { cardId: "RESPIN" });
      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.roundCount, 0);
      timers.flush();
      assert.equal(room.state.roundCount, 0);

      const cal = room.state.players.get("cal");
      assert.ok(cal);
      cal.cards.push("WILD CARD");
      emit(room, "use_card", clients[2], {
        cardId: "WILD CARD",
        category: "Trivia",
        type: "1v1",
        selectedPlayers: ["ada", "bea"],
      });
      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.equal(room.state.roundCount, 0);
      timers.flush();
      assert.equal(room.state.roundCount, 0);
    } finally {
      timers.restore();
    }
  });

  it("replays an aborted round at the same number", async () => {
    const { room, clients, broadcasts } = seat(["ada", "bea", "cal"]);
    enterChart(room, clients);
    playRounds(room, clients, 1);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 1);
    spin(room, clients);
    assert.equal(room.state.roundCount, 1);

    room.state.phase = "playing";
    room.state.currentGameType = "1v1";
    if (!room.state.selectedPlayers.includes("bea")) {
      room.state.selectedPlayers.push("bea");
    }
    await room.onLeave(clients[1] as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 1);
    assert.equal(room.state.totalRounds, 10);
    assert.equal(spins(broadcasts).length, 2);

    spin(room, [clients[0], clients[2]]);
    assert.equal(room.state.phase, "wheel");
    assert.equal(room.state.roundCount, 1);
    assert.equal(spins(broadcasts).length, 3);
  });

  it("keeps the round count when the host seat moves mid-match", async () => {
    const { room, clients } = seat(["ada", "bea", "cal"]);
    setRounds(room, clients[0], 20);
    enterChart(room, clients);
    playRounds(room, clients, 1);
    assert.equal(room.state.roundCount, 1);
    spin(room, clients);
    assert.equal(room.state.roundCount, 1);
    room.state.phase = "playing";
    const hostIndex = room.state.selectedPlayers.indexOf("ada");
    if (hostIndex >= 0) room.state.selectedPlayers.splice(hostIndex, 1);

    await room.onLeave(clients[0] as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.phase, "playing");
    assert.equal(room.state.roundCount, 1);
    assert.equal(room.state.totalRounds, 20);
    assert.equal(room.state.players.has("ada"), false);
    const hosts = [...room.state.players.values()].filter((player) => player.isHost && player.isConnected);
    assert.equal(hosts.length, 1);
    assert.notEqual(hosts[0].id, "ada");
  });

  it("deals the every-third-round cards from the displayed round number", () => {
    const { room, clients } = seat(["ada", "bea"]);
    enterChart(room, clients);
    room.state.roundCount = 2;
    const sent: string[] = [];
    for (const client of clients) {
      client.send = (type: string) => {
        if (type === "CardAwardedEvent") sent.push(client.sessionId);
      };
    }
    room.startResolutionPhase();
    assert.equal(room.state.phase, "resolution");
    assert.equal(room.state.roundCount, 3);
    assert.equal(sent.length, 1);
  });

  it("advances one resolved round at a time and reads multiples of 5 before the wheel", () => {
    const { room, clients, closed, broadcasts } = seat(["ada", "bea"]);
    setRounds(room, clients[0], 15);
    enterChart(room, clients);
    const bettingRounds: number[] = [];
    playRounds(room, clients, 10, (completed) => {
      const aboutToPlay = upcomingRoundNumber(completed);
      if (aboutToPlay % 5 === 0) bettingRounds.push(aboutToPlay);
      assert.notEqual(room.state.phase, "gameover");
    });
    assert.deepEqual(bettingRounds, [5, 10]);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 10);
    assert.equal(closed.count, 0);
    assert.equal(gameOvers(broadcasts).length, 0);
    assert.equal(spins(broadcasts).length, 10);

    playRounds(room, clients, 5, (completed) => {
      const aboutToPlay = upcomingRoundNumber(completed);
      if (aboutToPlay % 5 === 0) bettingRounds.push(aboutToPlay);
    });
    assert.deepEqual(bettingRounds, [5, 10, 15]);
    assert.equal(room.state.phase, "gameover");
    assert.equal(room.state.roundCount, 15);
    assert.equal(room.state.totalRounds, 15);
    assert.equal(closed.count, 1);
    assert.equal(spins(broadcasts).length, 15);
  });
});

describe("podium", { concurrency: 1 }, () => {
  it("ranks places 1, 2, and 3 and lets ties share a place", () => {
    assert.deepEqual(
      buildPodium([
        { id: "eve", name: "Eve", score: 1 },
        { id: "bea", name: "Bea", score: 12 },
        { id: "dee", name: "Dee", score: 7 },
        { id: "ada", name: "Ada", score: 12 },
        { id: "cal", name: "Cal", score: 7 },
      ]),
      [
        { place: 1, playerId: "ada", name: "Ada", score: 12 },
        { place: 1, playerId: "bea", name: "Bea", score: 12 },
        { place: 3, playerId: "cal", name: "Cal", score: 7 },
        { place: 3, playerId: "dee", name: "Dee", score: 7 },
      ],
    );

    assert.deepEqual(
      buildPodium([
        { id: "b", name: "Bea", score: 5 },
        { id: "a", name: "Ada", score: 9 },
        { id: "d", name: "Dee", score: 5 },
        { id: "c", name: "Cal", score: 5 },
      ]),
      [
        { place: 1, playerId: "a", name: "Ada", score: 9 },
        { place: 2, playerId: "b", name: "Bea", score: 5 },
        { place: 2, playerId: "c", name: "Cal", score: 5 },
        { place: 2, playerId: "d", name: "Dee", score: 5 },
      ],
    );

    assert.deepEqual(
      buildPodium([
        { id: "c", name: "Cal", score: 4 },
        { id: "a", name: "Ada", score: 4 },
        { id: "b", name: "Bea", score: 4 },
        { id: "d", name: "Dee", score: 4 },
      ]).map((seat) => seat.place),
      [1, 1, 1, 1],
    );

    assert.deepEqual(
      buildPodium([
        { id: "a", name: "Ada", score: 3 },
        { id: "b", name: "Bea", score: 2 },
        { id: "c", name: "Cal", score: 1 },
        { id: "d", name: "Dee", score: 0 },
      ]).map((seat) => seat.playerId),
      ["a", "b", "c"],
    );

    assert.deepEqual(
      buildPodium([
        { id: "b", name: "Bea", score: 2 },
        { id: "a", name: "Ada", score: 8 },
      ]),
      [
        { place: 1, playerId: "a", name: "Ada", score: 8 },
        { place: 2, playerId: "b", name: "Bea", score: 2 },
      ],
    );

    assert.deepEqual(buildPodium([{ id: "a", name: "Ada", score: 0 }]), [
      { place: 1, playerId: "a", name: "Ada", score: 0 },
    ]);
  });

  it("closes after the default 10 rounds with a two-place podium", () => {
    const { room, clients, closed, broadcasts, timeline } = seat(["ada", "bea"], {
      scores: { ada: 8, bea: 2 },
      drinks: { ada: 0, bea: 6 },
    });
    assert.equal(room.state.totalRounds, 10);
    enterChart(room, clients);
    playRounds(room, clients, 9);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 9);
    assert.equal(room.state.podium.length, 0);
    assert.equal(closed.count, 0);

    spin(room, clients);
    assert.equal(room.state.roundCount, 9);
    room.startResolutionPhase();
    assert.equal(room.state.phase, "resolution");
    assert.equal(room.state.roundCount, 10);
    assert.equal(room.state.podium.length, 0);
    assert.equal(closed.count, 0);
    readyOutOfResolution(room, clients);

    assert.equal(room.state.phase, "gameover");
    assert.deepEqual(timeline, ["patch:gameover:2", "event:gameover:2", "close:gameover:2"]);
    assert.equal(closed.phase, "gameover");
    assert.equal(closed.podiumLength, 2);
    assert.equal(gameOvers(broadcasts)[0].phase, "gameover");
    assert.equal(gameOvers(broadcasts)[0].podiumLength, 2);
    assert.equal(room.state.roundCount, 10);
    assert.equal(room.state.totalRounds, 10);
    assert.equal(closed.count, 1);
    assert.equal(spins(broadcasts).length, 10);
    const expected = [
      { place: 1, playerId: "ada", name: "ada", score: 8 },
      { place: 2, playerId: "bea", name: "bea", score: 2 },
    ];
    assert.deepEqual(podiumFromState(room), expected);
    assert.equal(gameOvers(broadcasts).length, 1);
    assert.deepEqual(gameOvers(broadcasts)[0].payload, {
      roundCount: 10,
      totalRounds: 10,
      podium: expected,
    });

    ready(room, clients[0]);
    ready(room, clients[1]);
    emit(room, "dev_start_wheel", clients[0], {
      type: "1v1",
      category: "Trivia",
      selectedPlayers: ["ada", "bea"],
    });
    emit(room, "end_match", clients[0], {});
    setRounds(room, clients[0], 50);
    assert.equal(room.state.phase, "gameover");
    assert.equal(room.state.roundCount, 10);
    assert.equal(closed.count, 1);
    assert.equal(spins(broadcasts).length, 10);
    assert.equal(room.startWheelPhase(), false);
    assert.deepEqual(lobbyError(clients[0]), roundsLockedError());
    assert.deepEqual(connectedHostIds(room), ["ada"]);
  });

  it("keeps one connected host on the podium after the host drops", async () => {
    const { room, clients } = seat(["ada", "bea", "cal"]);
    enterChart(room, clients);
    playRounds(room, clients, 9);
    spin(room, clients);
    room.startResolutionPhase();
    assert.equal(room.state.phase, "resolution");
    assert.equal(room.state.roundCount, 10);

    const pending = beginGrace(room, clients[0]);
    assert.equal(room.state.players.get("ada")?.isConnected, false);
    assert.equal(room.state.players.get("ada")?.isHost, false);
    assert.deepEqual(connectedHostIds(room), ["bea"]);
    assert.equal(room.state.phase, "resolution");

    room.state.selectedPlayers.clear();
    room.state.selectedPlayers.push("bea", "cal");
    readyOutOfResolution(room, clients);

    assert.equal(room.state.phase, "gameover");
    assert.equal(room.state.podium.length > 0, true);
    assert.deepEqual(connectedHostIds(room), ["bea"]);
    const hostFlags: string[] = [];
    room.state.players.forEach((player, id) => {
      if (player.isHost) hostFlags.push(id);
    });
    assert.deepEqual(hostFlags, ["bea"]);

    setRounds(room, clients[0], 20);
    assert.equal(room.state.totalRounds, 10);
    assert.deepEqual(lobbyError(clients[0]), notHostError());
    setRounds(room, clients[1], 50);
    assert.equal(room.state.totalRounds, 10);
    assert.deepEqual(lobbyError(clients[1]), roundsLockedError());

    await finishGrace(room, clients[0], pending);
  });

  it("broadcasts co-winners and skips 2nd, including a disconnected seat", () => {
    const { room, clients, closed, broadcasts } = seat(["ada", "bea", "cal", "dee", "eve"], {
      scores: { ada: 12, bea: 12, cal: 7, dee: 7, eve: 1 },
      drinks: { ada: 0, bea: 9, eve: 4 },
    });
    enterChart(room, clients);
    playRounds(room, clients, 9);
    spin(room, clients);
    const dee = room.state.players.get("dee");
    assert.ok(dee);
    dee.isConnected = false;
    room.startResolutionPhase();
    assert.equal(room.state.roundCount, 10);
    readyOutOfResolution(room, clients);

    const expected = [
      { place: 1, playerId: "ada", name: "ada", score: 12 },
      { place: 1, playerId: "bea", name: "bea", score: 12 },
      { place: 3, playerId: "cal", name: "cal", score: 7 },
      { place: 3, playerId: "dee", name: "dee", score: 7 },
    ];
    assert.equal(room.state.phase, "gameover");
    assert.equal(closed.count, 1);
    assert.deepEqual(podiumFromState(room), expected);
    assert.deepEqual(gameOvers(broadcasts)[0].payload, {
      roundCount: 10,
      totalRounds: 10,
      podium: expected,
    });
    assert.equal(room.state.players.get("eve")?.score, 1);
    assert.ok(!podiumFromState(room).some((seat) => seat.playerId === "eve"));
    assert.ok(!podiumFromState(room).some((seat) => seat.place === 2));
  });

  it("ranks a reconnect-grace seat and leaves out a consented departure", async () => {
    const { room, clients, closed } = seat(["ada", "bea", "cal"], {
      scores: { ada: 4, bea: 8, cal: 1 },
    });
    enterChart(room, clients);
    playRounds(room, clients, 9);
    spin(room, clients);
    assert.equal(room.state.roundCount, 9);
    room.startResolutionPhase();
    assert.equal(room.state.roundCount, 10);
    assert.equal(room.state.phase, "resolution");
    room.state.selectedPlayers.clear();
    room.state.selectedPlayers.push("ada", "bea");

    await room.onLeave(clients[2] as unknown as Client, CloseCode.CONSENTED);
    assert.equal(room.state.players.has("cal"), false);
    assert.equal(room.state.phase, "resolution");

    const grace = beginGrace(room, clients[1]);
    assert.equal(room.state.players.get("bea")?.isConnected, false);
    assert.equal(room.state.players.has("bea"), true);
    assert.equal(room.state.phase, "resolution");
    assert.equal(room.state.roundCount, 10);

    readyOutOfResolution(room, clients);

    assert.equal(room.state.phase, "gameover");
    assert.equal(closed.count, 1);
    assert.deepEqual(podiumFromState(room), [
      { place: 1, playerId: "bea", name: "bea", score: 8 },
      { place: 2, playerId: "ada", name: "ada", score: 4 },
    ]);
    assert.ok(room.state.players.has("bea"));
    assert.ok(!podiumFromState(room).some((seat) => seat.playerId === "cal"));

    await finishGrace(room, clients[1], grace);
  });

  it("applies double points and a shield before the podium, then closes", () => {
    const { room, clients, closed, broadcasts } = seat(["ada", "bea"]);
    enterChart(room, clients);
    playRounds(room, clients, 9);
    spin(room, clients);
    assert.equal(room.state.roundCount, 9);

    const ada = room.state.players.get("ada");
    const bea = room.state.players.get("bea");
    assert.ok(ada && bea);
    ada.score = 3;
    ada.activeEffects = JSON.stringify({ doublePoints: true });
    room.state.lastWinners.push("ada");
    bea.drinks = 1;
    bea.cards.push("SHIELD");
    room.state.lastLosers.push("bea");

    room.startResolutionPhase();
    assert.equal(room.state.roundCount, 10);
    assert.equal(ada.score, 6);
    assert.equal(ada.activeEffects, "");
    assert.equal(room.state.phase, "resolution");
    assert.equal(closed.count, 0);
    assert.equal(gameOvers(broadcasts).length, 0);

    emit(room, "use_card", clients[1], { cardId: "SHIELD", targetPlayerId: "ada" });
    assert.equal(bea.drinks, 0);
    assert.equal(ada.drinks, 1);
    assert.equal(room.state.phase, "resolution");
    assert.equal(closed.count, 0);

    readyOutOfResolution(room, clients);
    assert.equal(room.state.phase, "gameover");
    assert.equal(room.state.roundCount, 10);
    assert.equal(closed.count, 1);
    assert.deepEqual(podiumFromState(room), [
      { place: 1, playerId: "ada", name: "ada", score: 6 },
      { place: 2, playerId: "bea", name: "bea", score: 0 },
    ]);
  });
});

describe("room code is freed on disconnect", () => {
  let server: Server;
  let port = 0;

  before(async () => {
    server = new Server({
      greet: false,
      gracefullyShutdown: false,
      transport: new WebSocketTransport({ pingInterval: 0 }),
    });
    server.define("lobby", LobbyRoom);
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

  it("disconnect removes the lobby so its code cannot be joined", async () => {
    const created = await post("/matchmake/create/lobby", { name: "Ada" });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const roomId = String(created.json.roomId);
    const live = matchMaker.getLocalRoomById(roomId) as LobbyRoom;
    assert.equal(live.state.totalRounds, 10);
    assert.equal(live.state.roundCount, 0);

    await live.disconnect();

    const joined = await post(`/matchmake/joinById/${roomId}`, { name: "Bea" });
    assert.equal(joined.status, ErrorCode.MATCHMAKE_INVALID_ROOM_ID);
    assert.match(String(joined.json.error), /not found/);
    assert.equal(matchMaker.getLocalRoomById(roomId), undefined);
  });
});
