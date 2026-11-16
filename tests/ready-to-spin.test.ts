import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client, CloseCode } from "@colyseus/core";
import { DEV_TOOLS_ENV, LobbyRoom, isDevToolsEnabled } from "../src/rooms/LobbyRoom";
import { LOBBY_ERROR_EVENT, notEnoughPlayersError } from "../src/rooms/lobbyErrors";
import { Player } from "../src/rooms/schema/LobbyState";

interface SentMessage {
  type: string;
  payload: unknown;
}

interface Broadcast {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  sent: SentMessage[];
  send(type: string, payload: unknown): void;
  enqueueRaw(): void;
}

function bootRoom(): { room: LobbyRoom; broadcasts: Broadcast[] } {
  const room = new LobbyRoom();
  room.onCreate({});
  const broadcasts: Broadcast[] = [];
  room.broadcast = ((type: string, payload?: unknown) => {
    broadcasts.push({ type, payload });
  }) as LobbyRoom["broadcast"];
  return { room, broadcasts };
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

/** Chart with nobody ready, so seating itself does not spin. */
function chartRoom(ids: string[]): { room: LobbyRoom; broadcasts: Broadcast[]; clients: FakeClient[] } {
  const { room, broadcasts } = bootRoom();
  const clients = ids.map((id, index) => addPlayer(room, id, {
    name: id,
    host: index === 0,
  }));
  room.state.phase = "chart";
  room.checkAllReady();
  return { room, broadcasts, clients };
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

function spinEvents(broadcasts: Broadcast[]): Broadcast[] {
  return broadcasts.filter((entry) => entry.type === "SpinWheelEvent");
}

function stopLoops(room: LobbyRoom): void {
  if (room.gameLoopInterval) {
    clearInterval(room.gameLoopInterval);
    room.gameLoopInterval = null;
  }
}

/** Abnormal close. Colyseus passes a numeric code; only 4000 is a consented leave. */
function beginGrace(room: LobbyRoom, client: FakeClient): Promise<unknown> {
  (client as FakeClient & { reconnectionToken?: string }).reconnectionToken = `${client.sessionId}-grace`;
  return room.onLeave(client as unknown as Client, 1000);
}

async function finishGrace(room: LobbyRoom, client: FakeClient, pending: Promise<unknown>, reconnect: boolean): Promise<void> {
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

function playWildCard(
  room: LobbyRoom,
  client: FakeClient,
  options: { category: string; type: string; selectedPlayers: string[] },
): void {
  const player = room.state.players.get(client.sessionId);
  assert.ok(player);
  if (player.cards.indexOf("WILD CARD") === -1) player.cards.push("WILD CARD");
  emit(room, "use_card", client, { cardId: "WILD CARD", ...options });
}

describe("ready to spin", { concurrency: 1 }, () => {
  it("spins only after every connected player readies again on the chart", () => {
    const { room, broadcasts } = bootRoom();
    const host = addPlayer(room, "ada", { name: "Ada", host: true });
    const guest = addPlayer(room, "bea", { name: "Bea" });

    ready(room, host);
    assert.equal(room.state.phase, "lobby");
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.connectedCount, 2);
    assert.equal(spinEvents(broadcasts).length, 0);

    ready(room, guest);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.readyCount, 0);
    assert.equal(room.state.connectedCount, 2);
    assert.equal(room.state.players.get("ada")?.isReady, false);
    assert.equal(room.state.players.get("bea")?.isReady, false);
    assert.equal(spinEvents(broadcasts).length, 0);

    ready(room, host);
    assert.equal(room.state.phase, "chart");
    ready(room, guest);
    assert.equal(room.state.phase, "wheel");
    assert.equal(room.state.timer, 0);
    assert.equal(room.state.readyCount, 0);
    assert.equal(room.state.players.get("ada")?.isReady, false);
    assert.equal(room.state.players.get("bea")?.isReady, false);
    assert.equal(spinEvents(broadcasts).length, 1);
    const payload = spinEvents(broadcasts)[0].payload as { type: string; category: string; selectedPlayers: string[] };
    assert.ok(payload.category.length > 0);
    assert.deepEqual([...payload.selectedPlayers].sort(), ["ada", "bea"]);

    room.checkAllReady();
    assert.equal(room.state.phase, "wheel");

    ready(room, host);
    assert.equal(room.state.phase, "wheel");
    ready(room, guest);
    assert.equal(room.state.phase, "countdown");
    assert.equal(room.state.timer, 5);
    stopLoops(room);
  });

  it("spins for 12 connected players and refuses a solo chart ready", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `p${index}`);
    const { room, broadcasts, clients } = chartRoom(ids);
    for (const client of clients) ready(room, client);

    assert.equal(room.state.phase, "wheel");
    assert.equal(room.state.readyCount, 0);
    assert.equal(room.state.connectedCount, 12);
    assert.equal(spinEvents(broadcasts).length, 1);
    const selected = room.state.selectedPlayers.toArray();
    assert.ok(selected.length >= 2);
    assert.ok(selected.length <= 12);
    for (const id of selected) {
      assert.equal(room.state.players.get(id)?.isConnected, true);
    }

    const solo = chartRoom(["ada"]);
    ready(solo.room, solo.clients[0]);
    assert.equal(solo.room.state.phase, "chart");
    assert.equal(solo.room.state.readyCount, 1);
    assert.equal(solo.room.state.connectedCount, 1);
    assert.equal(spinEvents(solo.broadcasts).length, 0);
    assert.deepEqual(
      solo.clients[0].sent.find((entry) => entry.type === LOBBY_ERROR_EVENT)?.payload,
      notEnoughPlayersError(),
    );
  });

  it("does not let a disconnected player block the spin", async () => {
    const { room, broadcasts, clients } = chartRoom(["ada", "bea", "cal"]);
    const cal = room.state.players.get("cal");
    assert.ok(cal);
    cal.isConnected = false;
    cal.isReady = false;
    const index = room.clients.findIndex((client) => client.sessionId === "cal");
    room.clients.splice(index, 1);

    ready(room, clients[0]);
    ready(room, clients[1]);

    assert.equal(room.state.phase, "wheel");
    assert.equal(room.state.connectedCount, 2);
    assert.deepEqual([...room.state.selectedPlayers.toArray()].sort(), ["ada", "bea"]);
    assert.equal(spinEvents(broadcasts).length, 1);

    const leaving = chartRoom(["ada", "bea", "cal"]);
    ready(leaving.room, leaving.clients[0]);
    ready(leaving.room, leaving.clients[1]);
    assert.equal(leaving.room.state.phase, "chart");
    assert.equal(leaving.room.state.readyCount, 2);
    assert.equal(leaving.room.state.connectedCount, 3);

    await leaving.room.onLeave(leaving.clients[2] as unknown as Client, CloseCode.CONSENTED);

    assert.equal(leaving.room.state.phase, "wheel");
    assert.equal(leaving.room.state.players.has("cal"), false);
    assert.equal(leaving.room.state.connectedCount, 2);
    assert.equal(spinEvents(leaving.broadcasts).length, 1);
    assert.ok(!leaving.room.state.selectedPlayers.toArray().includes("cal"));

    const floor = chartRoom(["ada", "bea"]);
    ready(floor.room, floor.clients[0]);
    await floor.room.onLeave(floor.clients[1] as unknown as Client, CloseCode.CONSENTED);
    assert.equal(floor.room.state.phase, "chart");
    assert.equal(floor.room.state.connectedCount, 1);
    assert.equal(spinEvents(floor.broadcasts).length, 0);
  });

  it("a grace seat is disconnected, so it does not count or block the spin", async () => {
    const { room, broadcasts, clients } = chartRoom(["ada", "bea", "cal"]);
    const cal = room.state.players.get("cal");
    assert.ok(cal);
    cal.isReady = true;
    room.checkAllReady();
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.connectedCount, 3);
    assert.equal(room.state.phase, "chart");

    const pending = beginGrace(room, clients[2]);
    try {
      assert.equal(cal.isConnected, false);
      assert.equal(cal.isReady, true);
      assert.equal(room.state.readyCount, 0);
      assert.equal(room.state.connectedCount, 2);
      assert.equal(room.state.phase, "chart");

      ready(room, clients[0]);
      ready(room, clients[1]);
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.connectedCount, 2);
      assert.equal(room.state.readyCount, 0);
      assert.ok(!room.state.selectedPlayers.toArray().includes("cal"));
      assert.equal(spinEvents(broadcasts).length, 1);
    } finally {
      await finishGrace(room, clients[2], pending, true);
    }
  });

  it("a same-session reconnect within grace keeps isReady", async () => {
    const { room, clients } = chartRoom(["ada", "bea"]);
    ready(room, clients[0]);
    const ada = room.state.players.get("ada");
    assert.ok(ada);
    assert.equal(ada.isReady, true);
    assert.equal(room.state.phase, "chart");

    const pending = beginGrace(room, clients[0]);
    try {
      assert.equal(ada.isConnected, false);
      assert.equal(ada.isReady, true);
      assert.equal(room.state.readyCount, 0);
      assert.equal(room.state.connectedCount, 1);
      assert.equal(room.state.phase, "chart");
    } finally {
      await finishGrace(room, clients[0], pending, true);
    }

    assert.equal(ada.isConnected, true);
    assert.equal(ada.isReady, true);
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.connectedCount, 2);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.players.has("ada"), true);
  });

  it("un-readying before everyone is ready prevents the spin", () => {
    const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
    ready(room, clients[0]);
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.phase, "chart");

    ready(room, clients[0], false);
    assert.equal(room.state.players.get("ada")?.isReady, false);
    assert.equal(room.state.readyCount, 0);

    ready(room, clients[1]);
    assert.equal(room.state.phase, "chart");
    assert.equal(spinEvents(broadcasts).length, 0);

    ready(room, clients[0]);
    assert.equal(room.state.phase, "wheel");
    assert.equal(spinEvents(broadcasts).length, 1);
  });

  it("a new joiner starts not ready and blocks a chart that was otherwise ready", () => {
    const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
    ready(room, clients[0]);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.readyCount, 1);

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

    assert.equal(room.state.players.get("cal")?.isReady, false);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.connectedCount, 3);
    assert.equal(spinEvents(broadcasts).length, 0);

    ready(room, clients[1]);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.readyCount, 2);
    ready(room, cal);
    assert.equal(room.state.phase, "wheel");
  });

  it("a name rejoin does not copy isReady and cannot ride the previous seat into a spin", () => {
    const { room, broadcasts, clients } = chartRoom(["ada"]);
    addPlayer(room, "bea-old", { name: "Bea", connected: false, ready: true });
    ready(room, clients[0]);
    assert.equal(room.state.phase, "chart");
    assert.equal(spinEvents(broadcasts).length, 0);

    const rejoined: FakeClient = {
      sessionId: "bea-new",
      sent: [],
      send(type, payload) {
        this.sent.push({ type, payload });
      },
      enqueueRaw() {},
    };
    room.clients.push(rejoined as unknown as LobbyRoom["clients"][number]);
    room.onJoin(rejoined as unknown as Client, { name: "Bea" });

    assert.equal(room.state.players.has("bea-old"), false);
    assert.equal(room.state.players.get("bea-new")?.isReady, false);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.readyCount, 1);
    assert.equal(room.state.connectedCount, 2);
    assert.equal(spinEvents(broadcasts).length, 0);

    ready(room, rejoined);
    assert.equal(room.state.phase, "wheel");
  });

  it("ignores start_wheel from the host and does not spin on a timer", () => {
    const timers = useManualTimers();
    try {
      const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
      ready(room, clients[0]);
      emit(room, "start_wheel", clients[0]);
      emit(room, "start_wheel", clients[1]);
      timers.flush();
      timers.flush();

      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.currentGameType, "");
      assert.equal(spinEvents(broadcasts).length, 0);
      assert.equal(clients[0].sent.find((entry) => entry.type === LOBBY_ERROR_EVENT), undefined);
      assert.equal(clients[1].sent.find((entry) => entry.type === LOBBY_ERROR_EVENT), undefined);

      const ada = room.state.players.get("ada");
      const bea = room.state.players.get("bea");
      assert.ok(ada && bea);
      ada.isReady = true;
      bea.isReady = true;
      emit(room, "start_wheel", clients[0]);
      assert.equal(room.state.phase, "chart");
      assert.equal(spinEvents(broadcasts).length, 0);

      room.checkAllReady();
      assert.equal(room.state.phase, "wheel");
      assert.equal(spinEvents(broadcasts).length, 1);
    } finally {
      timers.restore();
    }
  });

  it("ignores dev_start_wheel when the dev flag is off", () => {
    assert.equal(isDevToolsEnabled({}), false);
    assert.equal(isDevToolsEnabled({ NODE_ENV: "production", [DEV_TOOLS_ENV]: "1" }), false);
    assert.equal(isDevToolsEnabled({ NODE_ENV: "development" }), false);
    assert.equal(isDevToolsEnabled({ [DEV_TOOLS_ENV]: "1" }), false);
    assert.equal(isDevToolsEnabled({ NODE_ENV: "test", [DEV_TOOLS_ENV]: "1" }), true);

    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env[DEV_TOOLS_ENV];
    delete process.env.NODE_ENV;
    delete process.env[DEV_TOOLS_ENV];
    try {
      const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
      emit(room, "dev_start_wheel", clients[0], {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.currentGameType, "");
      assert.equal(room.state.currentCategory, "");
      assert.equal(spinEvents(broadcasts).length, 0);
      assert.equal(clients[0].sent.find((entry) => entry.type === LOBBY_ERROR_EVENT), undefined);

      process.env.NODE_ENV = "production";
      process.env[DEV_TOOLS_ENV] = "1";
      emit(room, "dev_start_wheel", clients[0], {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.phase, "chart");
      assert.equal(spinEvents(broadcasts).length, 0);
      assert.equal(clients[0].sent.find((entry) => entry.type === LOBBY_ERROR_EVENT), undefined);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env[DEV_TOOLS_ENV];
      else process.env[DEV_TOOLS_ENV] = previousFlag;
    }
  });

  it("ignores dev_award_card when the dev flag is off", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env[DEV_TOOLS_ENV];
    delete process.env.NODE_ENV;
    delete process.env[DEV_TOOLS_ENV];
    try {
      const { room, clients } = chartRoom(["ada"]);
      emit(room, "dev_award_card", clients[0], { cardId: "WILD CARD", targetPlayerId: "ada" });
      assert.equal(room.state.players.get("ada")?.cards.length, 0);
      assert.equal(clients[0].sent.find((entry) => entry.type === "CardAwardedEvent"), undefined);

      process.env.NODE_ENV = "production";
      process.env[DEV_TOOLS_ENV] = "1";
      emit(room, "dev_award_card", clients[0], { cardId: "WILD CARD" });
      assert.equal(room.state.players.get("ada")?.cards.length, 0);
      assert.equal(clients[0].sent.find((entry) => entry.type === "CardAwardedEvent"), undefined);

      process.env.NODE_ENV = "test";
      emit(room, "dev_award_card", clients[0], { cardId: "WILD CARD" });
      assert.equal(room.state.players.get("ada")?.cards.length, 1);
      assert.equal(clients[0].sent.filter((entry) => entry.type === "CardAwardedEvent").length, 1);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env[DEV_TOOLS_ENV];
      else process.env[DEV_TOOLS_ENV] = previousFlag;
    }
  });

  it("allows host dev_start_wheel only when the dev flag is on", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFlag = process.env[DEV_TOOLS_ENV];
    process.env.NODE_ENV = "test";
    process.env[DEV_TOOLS_ENV] = "1";
    try {
      const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
      emit(room, "dev_start_wheel", clients[1], {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.phase, "chart");
      assert.equal(spinEvents(broadcasts).length, 0);

      emit(room, "dev_start_wheel", clients[0], {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.timer, 0);
      assert.equal(room.state.readyCount, 0);
      assert.equal(room.state.players.get("ada")?.isReady, false);
      room.checkAllReady();
      assert.equal(room.state.phase, "wheel");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFlag === undefined) delete process.env[DEV_TOOLS_ENV];
      else process.env[DEV_TOOLS_ENV] = previousFlag;
    }
  });

  it("lets a Wild Card resolve before the spin without skipping Ready to Play", () => {
    const timers = useManualTimers();
    const { room, broadcasts, clients } = chartRoom(["ada", "bea", "cal"]);
    try {
      playWildCard(room, clients[0], {
        category: "Scrabble",
        type: "1v1",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.players.get("ada")?.cards.indexOf("WILD CARD"), -1);
      assert.equal(room.state.phase, "chart");
      assert.equal(spinEvents(broadcasts).length, 0);
      assert.ok(broadcasts.some((entry) => entry.type === "CardUsedEvent"));

      ready(room, clients[0]);
      ready(room, clients[1]);
      ready(room, clients[2]);
      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.readyCount, 3);
      assert.equal(spinEvents(broadcasts).length, 0);

      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Scrabble");
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.timer, 0);
      assert.equal(room.state.readyCount, 0);
      assert.equal(room.state.players.get("ada")?.isReady, false);
      assert.equal(spinEvents(broadcasts).length, 1);
      assert.deepEqual([...room.state.selectedPlayers.toArray()].sort(), ["ada", "bea"]);

      timers.flush();
      assert.equal(room.state.phase, "wheel");

      playWildCard(room, clients[2], {
        category: "Trivia",
        type: "1v1",
        selectedPlayers: ["ada", "bea"],
      });
      ready(room, clients[0]);
      ready(room, clients[1]);
      assert.equal(room.state.phase, "wheel");
      assert.notEqual(room.state.phase, "countdown");

      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.equal(room.state.readyCount, 0);
      timers.flush();
      assert.equal(room.state.phase, "wheel");

      ready(room, clients[2]);
      assert.equal(room.state.phase, "wheel");
      ready(room, clients[0]);
      ready(room, clients[1]);
      assert.equal(room.state.phase, "countdown");
      assert.equal(room.state.timer, 5);

      const calPlayer = room.state.players.get("cal");
      assert.ok(calPlayer);
      calPlayer.cards.push("WILD CARD");
      const before = calPlayer.cards.length;
      emit(room, "use_card", clients[2], {
        cardId: "WILD CARD",
        category: "Cyclone",
        type: "BR",
        selectedPlayers: ["ada", "bea", "cal"],
      });
      assert.equal(calPlayer.cards.length, before);
      assert.equal(room.state.phase, "countdown");
      assert.equal(room.state.currentCategory, "Trivia");
    } finally {
      timers.restore();
      stopLoops(room);
    }
  });

  it("auto-spin leaves the post-wheel Wild Card window open until contestants ready", () => {
    const timers = useManualTimers();
    const { room, broadcasts, clients } = chartRoom(["ada", "bea"]);
    try {
      room.state.players.get("ada")?.cards.push("WILD CARD");
      ready(room, clients[0]);
      ready(room, clients[1]);

      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.timer, 0);
      assert.equal(room.state.readyCount, 0);
      assert.equal(room.state.players.get("ada")?.isReady, false);
      assert.equal(room.state.players.get("bea")?.isReady, false);
      assert.equal(spinEvents(broadcasts).length, 1);
      room.checkAllReady();
      assert.equal(room.state.phase, "wheel");

      playWildCard(room, clients[0], {
        category: "Scrabble",
        type: "1v1",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.players.get("ada")?.cards.indexOf("WILD CARD"), -1);
      ready(room, clients[0]);
      ready(room, clients[1]);
      assert.equal(room.state.phase, "wheel");
      assert.equal(spinEvents(broadcasts).length, 1);

      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Scrabble");
      assert.equal(room.state.readyCount, 0);
      assert.equal(spinEvents(broadcasts).length, 2);
      timers.flush();
      assert.equal(room.state.phase, "wheel");

      ready(room, clients[0]);
      ready(room, clients[1]);
      assert.equal(room.state.phase, "countdown");
      assert.equal(room.state.timer, 5);
    } finally {
      timers.restore();
      stopLoops(room);
    }
  });

  it("clears ready when a match aborts back to the chart and does not spin", async () => {
    const { room, broadcasts, clients } = chartRoom(["ada", "bea", "cal"]);
    room.state.phase = "playing";
    room.state.currentGameType = "1v1";
    room.state.selectedPlayers.push("ada", "bea");
    for (const id of ["ada", "bea", "cal"]) {
      const player = room.state.players.get(id);
      assert.ok(player);
      player.isReady = true;
    }

    await room.onLeave(clients[1] as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.players.get("ada")?.isReady, false);
    assert.equal(room.state.players.get("cal")?.isReady, false);
    assert.equal(room.state.readyCount, 0);
    assert.equal(room.state.connectedCount, 2);
    assert.equal(spinEvents(broadcasts).length, 0);
  });
});
