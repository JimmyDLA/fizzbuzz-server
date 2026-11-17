import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@colyseus/core";
import { DEV_TOOLS_ENV, LobbyRoom } from "../src/rooms/LobbyRoom";
import { LOBBY_ERROR_EVENT } from "../src/rooms/lobbyErrors";
import { Player } from "../src/rooms/schema/LobbyState";

/**
 * Chart DEV MODE options from fizzbuzz-app app/chart.tsx.
 * The client sends dev_start_wheel and dev_award_card. These tests pin each
 * option, and that both messages are ignored when the dev gate is off.
 */

const MENU_CARDS = ["TURBO", "SHIELD", "DOUBLE POINTS", "RESPIN", "WILD CARD"] as const;
const MENU_CATEGORIES = [
  "Tapping Race",
  "Math Problem",
  "Hot Potato",
  "Lumber Cut",
  "Trivia",
  "Rock Paper Scissors",
  "Cyclone",
  "Balloon Inflate",
  "Simon Says",
  "Scrabble",
  "Screen Painting",
  "Perfection",
] as const;

type Sent = { type: string; data: unknown };

function client(id: string, sent: Sent[]): Client {
  return {
    sessionId: id,
    sent,
    send(type: string, data: unknown) {
      sent.push({ type, data });
    },
    enqueueRaw() {},
  } as unknown as Client;
}

function boot(): LobbyRoom {
  const room = new LobbyRoom();
  room.onCreate({});
  room.broadcast = (() => {}) as LobbyRoom["broadcast"];
  return room;
}

function seat(room: LobbyRoom, id: string, host = false): Sent[] {
  const sent: Sent[] = [];
  const player = new Player();
  player.id = id;
  player.name = id;
  player.isHost = host;
  player.isConnected = true;
  player.score = 9;
  room.state.players.set(id, player);
  room.clients.push(client(id, sent));
  return sent;
}

function chart(ids: string[]): { room: LobbyRoom; sent: Record<string, Sent[]> } {
  const room = boot();
  const sent: Record<string, Sent[]> = {};
  ids.forEach((id, index) => {
    sent[id] = seat(room, id, index === 0);
  });
  room.state.phase = "chart";
  return { room, sent };
}

function emit(room: LobbyRoom, type: string, sessionId: string, message?: unknown): void {
  const sender = room.clients.find((entry) => entry.sessionId === sessionId);
  assert.ok(sender, sessionId);
  (room as unknown as {
    onMessageEvents: { emit: (event: string, ...args: unknown[]) => void };
  }).onMessageEvents.emit(type, sender, message);
}

function cards(room: LobbyRoom, id: string): string[] {
  return room.state.players.get(id)?.cards.toArray() ?? [];
}

function rounds(room: LobbyRoom, id: string): number[] {
  return room.state.players.get(id)?.earnedRounds.toArray() ?? [];
}

function withDevTools(fn: () => void): void {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env[DEV_TOOLS_ENV];
  process.env.NODE_ENV = "test";
  process.env[DEV_TOOLS_ENV] = "1";
  try {
    fn();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env[DEV_TOOLS_ENV];
    else process.env[DEV_TOOLS_ENV] = previousFlag;
  }
}

function withoutDevTools(fn: () => void): void {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env[DEV_TOOLS_ENV];
  delete process.env.NODE_ENV;
  delete process.env[DEV_TOOLS_ENV];
  try {
    fn();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env[DEV_TOOLS_ENV];
    else process.env[DEV_TOOLS_ENV] = previousFlag;
  }
}

/** RESPIN and WILD CARD schedule the wheel. Don't wait for it. */
function withoutAnimationTimers(fn: () => void): void {
  const real = global.setTimeout;
  global.setTimeout = (() => ({
    unref() {},
    ref() {},
    hasRef() { return false; },
  })) as unknown as typeof setTimeout;
  try {
    fn();
  } finally {
    global.setTimeout = real;
  }
}

describe("dev menu", { concurrency: 1 }, () => {
  for (const cardId of MENU_CARDS) {
    it(`awards ${cardId} immediately usable`, () => {
      withDevTools(() => {
        const { room, sent } = chart(["ada", "bea"]);
        emit(room, "dev_award_card", "ada", { targetPlayerId: "bea", cardId });
        assert.deepEqual(cards(room, "bea"), [cardId]);
        assert.deepEqual(rounds(room, "bea"), [0]);
        const event = sent.bea.find((entry) => entry.type === "CardAwardedEvent");
        assert.deepEqual(event?.data, {
          cardId,
          earnedRound: 0,
          reason: "DEV OVERRIDE",
          message: `Dev granted you a ${cardId} card!`,
        });

        const errors = () => sent.bea.filter((entry) => entry.type === "CardErrorEvent");

        if (cardId === "SHIELD") {
          room.state.phase = "resolution";
          room.state.roundCount = 1;
          const beaPlayer = room.state.players.get("bea");
          assert.ok(beaPlayer);
          beaPlayer.drinks = 1;
          room.state.lastLosers.push("bea");
          (room as unknown as { seedDrinkChains(): void }).seedDrinkChains();
          emit(room, "use_card", "bea", { cardId: "SHIELD", targetPlayerId: "ada" });
          assert.deepEqual(cards(room, "bea"), []);
          assert.equal(errors().length, 0);
          assert.equal(room.state.players.get("ada")?.drinks, 1);
          return;
        }

        room.state.phase = "wheel";
        room.state.currentCategory = "Tapping Race";
        room.state.selectedPlayers.clear();
        room.state.selectedPlayers.push("bea");
        const play = () => emit(room, "use_card", "bea", {
          cardId,
          ...(cardId === "WILD CARD" ? { category: "Trivia", type: "1v1", selectedPlayers: ["ada", "bea"] } : {}),
        });
        if (cardId === "RESPIN" || cardId === "WILD CARD") withoutAnimationTimers(play);
        else play();

        assert.equal(errors().length, 0);
        assert.equal(cards(room, "bea").includes(cardId), false);
        if (cardId === "TURBO") {
          assert.equal(JSON.parse(room.state.players.get("bea")?.activeEffects || "{}").turbo, true);
        }
        if (cardId === "DOUBLE POINTS") {
          assert.equal(JSON.parse(room.state.players.get("bea")?.activeEffects || "{}").doublePoints, true);
        }
      });
    });
  }

  it("still skips a dev award that would be a 4th card", () => {
    withDevTools(() => {
      const { room } = chart(["ada"]);
      emit(room, "dev_award_card", "ada", { cardId: "TURBO" });
      emit(room, "dev_award_card", "ada", { cardId: "SHIELD" });
      emit(room, "dev_award_card", "ada", { cardId: "DOUBLE POINTS" });
      emit(room, "dev_award_card", "ada", { cardId: "RESPIN" });
      emit(room, "dev_award_card", "ada", { cardId: "WILD CARD" });
      assert.deepEqual(cards(room, "ada"), ["TURBO", "SHIELD", "DOUBLE POINTS"]);
      assert.equal(room.state.players.get("ada")?.pendingDiscard, true);
    });
  });

  for (const category of MENU_CATEGORIES) {
    it(`force-starts 1v1 ${category} for the selected players`, () => {
      withDevTools(() => {
        const { room } = chart(["ada", "bea", "cal"]);
        emit(room, "dev_start_wheel", "ada", {
          type: "1v1",
          category,
          selectedPlayers: ["ada", "bea"],
        });
        assert.equal(room.state.phase, "wheel");
        assert.equal(room.state.currentGameType, "1v1");
        assert.equal(room.state.currentCategory, category);
        assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea"]);
        assert.equal(room.state.bettingPot, 0);
      });
    });
  }

  it("force-starts 2v2 and BR with the requested roster", () => {
    withDevTools(() => {
      const { room } = chart(["ada", "bea", "cal", "dee"]);
      emit(room, "dev_start_wheel", "ada", {
        type: "2v2",
        category: "Tapping Race",
        selectedPlayers: ["ada", "bea", "cal", "dee"],
      });
      assert.equal(room.state.currentGameType, "2v2");
      assert.equal(room.state.currentCategory, "Tapping Race");
      assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea", "cal", "dee"]);

      room.state.phase = "chart";
      emit(room, "dev_start_wheel", "ada", {
        type: "BR",
        category: "Hot Potato",
        selectedPlayers: ["ada", "bea", "cal"],
      });
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentGameType, "BR");
      assert.equal(room.state.currentCategory, "Hot Potato");
      assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea", "cal"]);
    });
  });

  it("keeps a dev 1v1 on a betting round and still forces the real wheel to Battle Royale", () => {
    withDevTools(() => {
      const { room } = chart(["ada", "bea", "cal"]);
      room.state.roundCount = 4;
      room.state.isBettingRound = true;

      emit(room, "dev_start_wheel", "ada", {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea"]);
      assert.equal(room.state.players.get("ada")?.score, 6);
      assert.equal(room.state.players.get("bea")?.score, 6);
      assert.equal(room.state.players.get("cal")?.score, 9);
      assert.equal(room.state.bettingPot, 6);

      const normal = chart(["ada", "bea", "cal"]);
      normal.room.state.roundCount = 4;
      assert.equal(normal.room.startWheelPhase(), true);
      assert.equal(normal.room.state.currentGameType, "BR");
      assert.deepEqual(normal.room.state.selectedPlayers.toArray().slice().sort(), ["ada", "bea", "cal"]);

      const wild = chart(["ada", "bea", "cal"]);
      wild.room.state.roundCount = 4;
      wild.room.state.phase = "chart";
      assert.equal(wild.room.forceWheelPhase("1v1", "Scrabble", ["ada", "bea"]), true);
      assert.equal(wild.room.state.currentGameType, "BR");
      assert.deepEqual(wild.room.state.selectedPlayers.toArray().slice().sort(), ["ada", "bea", "cal"]);
    });
  });

  it("ignores every dev option when the gate is off, from a non-host, and outside chart", () => {
    withoutDevTools(() => {
      const { room, sent } = chart(["ada", "bea"]);
      for (const cardId of MENU_CARDS) {
        emit(room, "dev_award_card", "ada", { targetPlayerId: "bea", cardId });
      }
      emit(room, "dev_start_wheel", "ada", {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.deepEqual(cards(room, "bea"), []);
      assert.equal(room.state.phase, "chart");
      assert.equal(room.state.currentGameType, "");
      assert.equal(sent.ada.find((entry) => entry.type === LOBBY_ERROR_EVENT), undefined);

      process.env.NODE_ENV = "production";
      process.env[DEV_TOOLS_ENV] = "1";
      emit(room, "dev_award_card", "ada", { cardId: "WILD CARD" });
      emit(room, "dev_start_wheel", "ada", {
        type: "BR",
        category: "Cyclone",
        selectedPlayers: ["ada", "bea"],
      });
      assert.deepEqual(cards(room, "ada"), []);
      assert.equal(room.state.phase, "chart");
    });

    withDevTools(() => {
      const { room } = chart(["ada", "bea"]);
      emit(room, "dev_award_card", "bea", { cardId: "SHIELD" });
      emit(room, "dev_start_wheel", "bea", {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.deepEqual(cards(room, "bea"), []);
      assert.equal(room.state.phase, "chart");

      emit(room, "dev_start_wheel", "ada", {
        type: "1v1",
        category: "Trivia",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.phase, "wheel");
      emit(room, "dev_start_wheel", "ada", {
        type: "BR",
        category: "Cyclone",
        selectedPlayers: ["ada", "bea"],
      });
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.currentCategory, "Trivia");
      emit(room, "dev_award_card", "ada", { cardId: "TURBO" });
      assert.deepEqual(cards(room, "ada"), ["TURBO"]);
    });
  });
});
