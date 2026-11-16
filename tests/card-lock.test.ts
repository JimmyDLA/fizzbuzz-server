import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { Player } from "../src/rooms/schema/LobbyState";

interface Broadcast {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  sent: unknown[];
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

function addPlayer(room: LobbyRoom, id: string, host = false): FakeClient {
  const player = new Player();
  player.id = id;
  player.name = id;
  player.isHost = host;
  player.isConnected = true;
  room.state.players.set(id, player);
  const client: FakeClient = {
    sessionId: id,
    sent: [],
    send() {},
    enqueueRaw() {},
  };
  room.clients.push(client as unknown as LobbyRoom["clients"][number]);
  return client;
}

function chartRoom(): { room: LobbyRoom; broadcasts: Broadcast[]; ada: FakeClient; bea: FakeClient } {
  const { room, broadcasts } = bootRoom();
  const ada = addPlayer(room, "ada", true);
  const bea = addPlayer(room, "bea");
  room.state.phase = "chart";
  room.checkAllReady();
  return { room, broadcasts, ada, bea };
}

function emit(room: LobbyRoom, type: string, client: FakeClient, message?: unknown): void {
  (room as unknown as {
    onMessageEvents: { emit: (event: string, ...args: unknown[]) => void };
  }).onMessageEvents.emit(type, client, message);
}

function cardLocked(room: LobbyRoom): boolean {
  return (room as unknown as { isCardLocked: boolean }).isCardLocked;
}

function playWildCard(room: LobbyRoom, client: FakeClient): void {
  const player = room.state.players.get(client.sessionId);
  assert.ok(player);
  player.cards.push("WILD CARD");
  emit(room, "use_card", client, {
    cardId: "WILD CARD",
    category: "Trivia",
    type: "1v1",
    selectedPlayers: ["ada", "bea"],
  });
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

describe("card lock", { concurrency: 1 }, () => {
  it("a Wild Card lock survives startWheelPhase", () => {
    const timers = useManualTimers();
    const { room, ada } = chartRoom();
    try {
      playWildCard(room, ada);
      assert.equal(cardLocked(room), true);

      assert.equal(room.startWheelPhase(), true);
      assert.equal(room.state.phase, "wheel");
      assert.equal(cardLocked(room), true);
    } finally {
      timers.restore();
    }
  });

  it("a Wild Card lock survives forceWheelPhase", () => {
    const timers = useManualTimers();
    const { room, ada } = chartRoom();
    try {
      playWildCard(room, ada);
      assert.equal(cardLocked(room), true);

      assert.equal(room.forceWheelPhase("1v1", "Scrabble", ["ada", "bea"]), true);
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Scrabble");
      assert.equal(cardLocked(room), true);
    } finally {
      timers.restore();
    }
  });

  it("a Ready press during the lock does not start a spin", () => {
    const timers = useManualTimers();
    const { room, broadcasts, ada, bea } = chartRoom();
    try {
      playWildCard(room, ada);
      assert.equal(cardLocked(room), true);

      emit(room, "ready", ada, { isReady: true });
      emit(room, "ready", bea, { isReady: true });

      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.readyCount, 2);
      assert.equal(broadcasts.filter((entry) => entry.type === "SpinWheelEvent").length, 0);
      assert.equal(cardLocked(room), true);
    } finally {
      timers.restore();
    }
  });

  it("the lock clears on the card timer, after the wheel has already been forced", () => {
    const timers = useManualTimers();
    const { room, ada, bea } = chartRoom();
    try {
      playWildCard(room, ada);
      emit(room, "ready", ada, { isReady: true });
      emit(room, "ready", bea, { isReady: true });
      assert.equal(room.state.phase, "chart");

      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.equal(cardLocked(room), true);

      emit(room, "ready", ada, { isReady: true });
      emit(room, "ready", bea, { isReady: true });
      assert.equal(room.state.phase, "wheel");
      assert.notEqual(room.state.phase, "countdown");

      timers.flush();
      assert.equal(cardLocked(room), false);
    } finally {
      timers.restore();
      if (room.gameLoopInterval) {
        clearInterval(room.gameLoopInterval);
        room.gameLoopInterval = null;
      }
    }
  });
});
