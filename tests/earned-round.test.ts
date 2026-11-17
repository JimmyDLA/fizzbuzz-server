import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@colyseus/core";
import { LobbyRoom, PENDING_DISCARD_MS } from "../src/rooms/LobbyRoom";
import { Player } from "../src/rooms/schema/LobbyState";
import { client, enableDevTools, leaveConsented } from "./helpers";

enableDevTools();

/**
 * A card earned in round N can be played starting round N+1.
 * During resolution the round in progress is roundCount (already incremented,
 * and the moment cards are dealt). Every other phase is roundCount + 1.
 * Shield earned this round cannot block in that same resolution.
 */

const PROACTIVE = ["RESPIN", "WILD CARD", "TURBO", "DOUBLE POINTS"] as const;

type Sent = { type: string; data: unknown };

type CardError = {
  cardId: string;
  code: string;
  earnedRound: number;
  message: string;
};

function hand(player: Player): string[] {
  return player.cards.toArray();
}

function rounds(player: Player): number[] {
  return player.earnedRounds.toArray();
}

function advance(room: LobbyRoom, ms: number): void {
  const clock = room.clock as unknown as { now: () => number; currentTime: number; tick: () => void };
  const target = clock.currentTime + ms;
  clock.now = () => target;
  clock.tick();
}

function emit(room: LobbyRoom, type: string, sessionId: string, message?: unknown, sent?: Sent[]): void {
  const events = (room as unknown as {
    onMessageEvents: { emit: (event: string, sender: unknown, payload?: unknown) => void };
  }).onMessageEvents;
  events.emit(type, {
    sessionId,
    send(event: string, data: unknown) {
      sent?.push({ type: event, data });
    },
    enqueueRaw() {},
  }, message ?? {});
}

function setup(): LobbyRoom {
  const room = new LobbyRoom();
  room.onCreate({});
  const broadcasts: Sent[] = [];
  const original = room.broadcast.bind(room);
  room.broadcast = ((type: string, data?: unknown) => {
    broadcasts.push({ type, data });
    return original(type, data);
  }) as typeof room.broadcast;
  (room as unknown as { broadcasts: Sent[] }).broadcasts = broadcasts;
  return room;
}

function addPlayer(room: LobbyRoom, id: string, name: string, host = false): { player: Player; messages: Sent[] } {
  const messages: Sent[] = [];
  const player = new Player();
  player.id = id;
  player.name = name;
  const hostTaken = Array.from(room.state.players.values()).some((existing) => existing.isHost);
  player.isHost = host && !hostTaken;
  player.isConnected = true;
  player.isReady = false;
  player.score = 0;
  room.state.players.set(id, player);
  room.clients.push({
    sessionId: id,
    send(type: string, data: unknown) {
      messages.push({ type, data });
    },
    enqueueRaw() {},
  } as unknown as Client);
  return { player, messages };
}

function seedChains(room: LobbyRoom): void {
  (room as unknown as { seedDrinkChains(): void }).seedDrinkChains();
}

function roundInProgress(room: LobbyRoom): number {
  if (room.state.phase === "resolution") return room.state.roundCount;
  return room.state.roundCount + 1;
}

function award(room: LobbyRoom, id: string, cardId: string, from = id): void {
  enableDevTools();
  const player = room.state.players.get(id);
  const before = player?.cards.length ?? 0;
  emit(room, "dev_award_card", from, { targetPlayerId: id, cardId });
  if (!player || player.cards.length === before) return;
  // A dev grant is playable immediately (earned round 0). These lock tests
  // still need the card stamped for the round in progress.
  player.earnedRounds[player.earnedRounds.length - 1] = roundInProgress(room);
}

/** A forced spin needs two connected players once the wheel checks the floor. */
function spin(room: LobbyRoom, type: string, category: string, primary = "ada"): void {
  const ids = [primary];
  room.state.players.forEach((player, id) => {
    if (id !== primary && player.isConnected) ids.push(id);
  });
  if (ids.length < 2) {
    const mate = `${primary}-mate`;
    addPlayer(room, mate, "Mate");
    ids.push(mate);
  }
  room.forceWheelPhase(type, category, ids);
}

function lastError(sent: Sent[]): CardError {
  const found = sent.filter((entry) => entry.type === "CardErrorEvent");
  assert.ok(found.length >= 1, "expected CardErrorEvent");
  return found[found.length - 1].data as CardError;
}

function usedEvents(room: LobbyRoom): Sent[] {
  return (room as unknown as { broadcasts: Sent[] }).broadcasts.filter((entry) => entry.type === "CardUsedEvent");
}

/** RESPIN and WILD CARD schedule a 3s announcement. Don't wait for it. */
function withoutAnimationTimers(fn: () => void): void {
  const real = global.setTimeout;
  global.setTimeout = (() => {
    return { unref() {}, ref() {}, hasRef() { return false; } };
  }) as unknown as typeof setTimeout;
  try {
    fn();
  } finally {
    global.setTimeout = real;
  }
}

function play(room: LobbyRoom, cardId: string, sessionId: string, message: Record<string, unknown>, sent?: Sent[]): void {
  const emitPlay = () => emit(room, "use_card", sessionId, { cardId, ...message }, sent);
  if (cardId === "RESPIN" || cardId === "WILD CARD") withoutAnimationTimers(emitPlay);
  else emitPlay();
}

function armWheel(room: LobbyRoom, sessionId: string): void {
  room.state.phase = "wheel";
  room.state.currentCategory = "Tapping Race";
  room.state.selectedPlayers.clear();
  room.state.selectedPlayers.push(sessionId);
}

describe("earned round is stamped once, in awardCard", () => {
  it("records the resolution round on the schema and on CardAwardedEvent", () => {
    const room = setup();
    const ada = addPlayer(room, "ada", "Ada", true);
    const bea = addPlayer(room, "bea", "Bea");
    room.state.roundCount = 2;

    room.startResolutionPhase();

    assert.equal(room.state.roundCount, 3);
    assert.equal(room.state.phase, "resolution");
    const holders = [ada.player, bea.player].filter((entry) => entry.cards.length > 0);
    assert.equal(holders.length, 1);
    const cardId = holders[0].cards[0];
    assert.deepEqual(rounds(holders[0]), [3]);
    const awarded = [...ada.messages, ...bea.messages].filter((entry) => entry.type === "CardAwardedEvent");
    assert.equal(awarded.length, 1);
    assert.equal((awarded[0].data as { earnedRound: number }).earnedRound, 3);

    const errors: Sent[] = [];
    emit(room, "use_card", holders[0].id, { cardId, targetPlayerId: "bea" }, errors);
    assert.deepEqual(hand(holders[0]), [cardId]);
    assert.equal(lastError(errors).code, "earned_this_round");
    assert.equal(lastError(errors).earnedRound, 3);
    assert.equal(usedEvents(room).length, 0);
  });

  it("stamps a dev grant as already usable", () => {
    const room = setup();
    const { player, messages } = addPlayer(room, "ada", "Ada", true);
    addPlayer(room, "bea", "Bea");
    room.state.phase = "wheel";
    room.state.roundCount = 4;
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");

    emit(room, "dev_award_card", "ada", { cardId: "TURBO" });

    assert.deepEqual(hand(player), ["TURBO"]);
    assert.deepEqual(rounds(player), [0]);
    const awarded = messages.filter((entry) => entry.type === "CardAwardedEvent");
    assert.equal((awarded[0].data as { earnedRound: number }).earnedRound, 0);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.equal(errors.length, 0);
    assert.deepEqual(hand(player), []);
    assert.equal(JSON.parse(player.activeEffects).turbo, true);
  });
});

describe("same round rejected, next round allowed", () => {
  for (const cardId of PROACTIVE) {
    it(`rejects ${cardId} on the wheel it was earned and allows it the next wheel`, () => {
      const room = setup();
      const { player, messages } = addPlayer(room, "ada", "Ada", true);
      armWheel(room, "ada");
      room.state.roundCount = 4;
      award(room, "ada", cardId);
      assert.deepEqual(rounds(player), [5]);

      const errors: Sent[] = [];
      play(room, cardId, "ada", {}, errors);
      assert.deepEqual(hand(player), [cardId]);
      assert.deepEqual(rounds(player), [5]);
      assert.equal(lastError(errors).code, "earned_this_round");
      assert.equal(lastError(errors).cardId, cardId);
      assert.equal(lastError(errors).earnedRound, 5);
      assert.equal(player.activeEffects, "");
      assert.equal(usedEvents(room).length, 0);

      room.state.phase = "resolution";
      room.state.roundCount = 5;
      play(room, cardId, "ada", {}, errors);
      assert.deepEqual(hand(player), [cardId]);
      assert.equal(lastError(errors).earnedRound, 5);

      armWheel(room, "ada");
      room.state.roundCount = 5;
      const errorCount = errors.length;
      play(room, cardId, "ada", {}, errors);
      assert.deepEqual(hand(player), []);
      assert.equal(errors.length, errorCount);
      assert.equal(usedEvents(room).length, 1);
    });
  }

  it("rejects SHIELD in the resolution it was earned and allows it the next resolution", () => {
    const room = setup();
    const { player, messages } = addPlayer(room, "ada", "Ada", true);
    const { player: bea } = addPlayer(room, "bea", "Bea");
    room.state.phase = "resolution";
    room.state.roundCount = 3;
    award(room, "ada", "SHIELD");
    assert.deepEqual(rounds(player), [3]);
    player.drinks = 1;
    room.state.lastLosers.push("ada");
    seedChains(room);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "SHIELD", targetPlayerId: "bea" }, errors);

    assert.deepEqual(hand(player), ["SHIELD"]);
    assert.equal(player.drinks, 1);
    assert.equal(bea.drinks, 0);
    assert.equal(lastError(errors).code, "earned_this_round");
    assert.equal(lastError(errors).cardId, "SHIELD");
    assert.equal(lastError(errors).earnedRound, 3);
    assert.equal(usedEvents(room).length, 0);

    room.state.roundCount = 4;
    const errorCount = errors.length;
    emit(room, "use_card", "ada", { cardId: "SHIELD", targetPlayerId: "bea" }, errors);

    assert.deepEqual(hand(player), []);
    assert.equal(errors.length, errorCount);
    assert.equal(player.drinks, 0);
    assert.equal(bea.drinks, 1);
    assert.equal(usedEvents(room).length, 1);
  });

  it("allows WILD CARD on the next round's chart and wheel, and not during the 5s countdown", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    addPlayer(room, "bea", "Bea");
    room.state.phase = "resolution";
    room.state.roundCount = 3;
    award(room, "ada", "WILD CARD");

    room.state.phase = "chart";
    const errors: Sent[] = [];
    play(room, "WILD CARD", "ada", { category: "Trivia", type: "1v1", selectedPlayers: ["ada", "bea"] }, errors);
    assert.deepEqual(hand(player), []);
    assert.equal(errors.length, 0);
    assert.equal(usedEvents(room).length, 1);

    const again = setup();
    const held = addPlayer(again, "ada", "Ada", true);
    addPlayer(again, "bea", "Bea");
    again.state.phase = "resolution";
    again.state.roundCount = 3;
    award(again, "ada", "WILD CARD");
    again.state.phase = "countdown";
    again.state.roundCount = 3;
    play(again, "WILD CARD", "ada", {}, errors);
    assert.deepEqual(hand(held.player), ["WILD CARD"]);
    assert.equal(errors.length, 0);
    assert.equal(usedEvents(again).length, 0);

    armWheel(again, "ada");
    again.state.roundCount = 3;
    play(again, "WILD CARD", "ada", {}, errors);
    assert.deepEqual(hand(held.player), []);
    assert.equal(errors.length, 0);
    assert.equal(usedEvents(again).length, 1);
  });

  it("does not error when the player does not hold the card", () => {
    const room = setup();
    addPlayer(room, "ada", "Ada", true);
    armWheel(room, "ada");
    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "RESPIN" }, errors);
    assert.equal(errors.length, 0);
  });

  it("plays an older copy when another copy was earned this round", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 1;
    award(room, "ada", "TURBO");
    armWheel(room, "ada");
    room.state.roundCount = 1;
    emit(room, "use_card", "ada", { cardId: "TURBO" });
    assert.equal(JSON.parse(player.activeEffects).turboEarnedRound, 1);

    room.state.phase = "resolution";
    room.state.roundCount = 2;
    award(room, "ada", "TURBO");
    assert.deepEqual(rounds(player), [2]);

    room.state.roundCount = 1;
    spin(room, "1v1", "Simon Says");
    assert.deepEqual(hand(player), ["TURBO", "TURBO"]);
    assert.deepEqual(rounds(player), [2, 1]);

    armWheel(room, "ada");
    room.state.roundCount = 1;
    emit(room, "use_card", "ada", { cardId: "TURBO" });
    assert.deepEqual(hand(player), ["TURBO"]);
    assert.deepEqual(rounds(player), [2]);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["TURBO"]);
    assert.equal(lastError(errors).code, "earned_this_round");
    assert.equal(lastError(errors).earnedRound, 2);
  });
});

describe("hand cap, auto-discard, and reconnect", () => {
  it("keeps the new card locked after the player discards an older one", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 1;
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    armWheel(room, "ada");
    room.state.roundCount = 1;
    award(room, "ada", "TURBO");
    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "TURBO"]);
    assert.deepEqual(rounds(player), [1, 1, 2]);

    emit(room, "discard_card", "ada", { cardIndex: 0 });
    assert.deepEqual(hand(player), ["RESPIN", "TURBO"]);
    assert.deepEqual(rounds(player), [1, 2]);
    assert.equal(player.pendingDiscard, false);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["RESPIN", "TURBO"]);
    assert.equal(lastError(errors).earnedRound, 2);

    play(room, "RESPIN", "ada", {}, errors);
    assert.deepEqual(hand(player), ["TURBO"]);
    assert.deepEqual(rounds(player), [2]);

    room.state.roundCount = 2;
    armWheel(room, "ada");
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), []);
  });

  it("drops the oldest card after 15s and leaves the new card locked", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 6;
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    award(room, "ada", "TURBO");
    assert.equal(player.pendingDiscard, true);

    advance(room, PENDING_DISCARD_MS);
    assert.deepEqual(hand(player), ["RESPIN", "TURBO"]);
    assert.deepEqual(rounds(player), [6, 6]);
    assert.equal(player.pendingDiscard, false);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["RESPIN", "TURBO"]);
    assert.equal(lastError(errors).code, "earned_this_round");

    armWheel(room, "ada");
    const errorCount = errors.length;
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["RESPIN"]);
    assert.deepEqual(rounds(player), [6]);
    assert.equal(errors.length, errorCount);
  });

  it("stays silent while a 3rd card is waiting to be discarded", () => {
    const room = setup();
    const { player, messages } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 2;
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    award(room, "ada", "TURBO");
    armWheel(room, "ada");

    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "SHIELD" }, errors);
    assert.equal(errors.length, 0);
    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "TURBO"]);
    assert.equal(usedEvents(room).length, 0);
  });

  it("restores earnedRound from the disconnect cache and keeps the lock", async () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 5;
    award(room, "ada", "SHIELD");
    room.state.roundCount = 6;
    award(room, "ada", "TURBO");
    assert.deepEqual(rounds(player), [5, 6]);
    player.score = 9;
    player.drinks = 2;

    await leaveConsented(room, "ada");
    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["SHIELD", "TURBO"]);
    assert.deepEqual(rounds(restored), [5, 6]);
    assert.equal(restored.score, 9);

    const errors: Sent[] = [];
    emit(room, "use_card", "ada-2", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(restored), ["SHIELD", "TURBO"]);
    assert.equal(lastError(errors).earnedRound, 6);

    addPlayer(room, "bea", "Bea");
    restored.drinks = 1;
    room.state.lastLosers.push("ada-2");
    seedChains(room);
    emit(room, "use_card", "ada-2", { cardId: "SHIELD", targetPlayerId: "bea" }, errors);
    assert.deepEqual(hand(restored), ["TURBO"]);
    assert.deepEqual(rounds(restored), [6]);
    assert.equal(room.state.players.get("bea")!.drinks, 1);
  });

  it("restores earnedRound when rejoining a disconnected session", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 4;
    award(room, "ada", "DOUBLE POINTS");
    room.state.roundCount = 8;
    award(room, "ada", "WILD CARD");
    player.isConnected = false;

    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.equal(room.state.players.has("ada"), false);
    assert.deepEqual(hand(restored), ["DOUBLE POINTS", "WILD CARD"]);
    assert.deepEqual(rounds(restored), [4, 8]);
  });

  it("drops the oldest cached card and keeps the new card's earnedRound", () => {
    const room = setup();
    (room as unknown as {
      disconnectedPlayersCache: Map<string, {
        score: number;
        drinks: number;
        cards: string[];
        cardAcquiredAt: number[];
        cardEarnedRounds?: number[];
        activeEffects: string;
      }>;
    }).disconnectedPlayersCache.set("ada", {
      score: 4,
      drinks: 1,
      cards: ["NEW", "MID", "OLD"],
      cardAcquiredAt: [30, 20, 10],
      cardEarnedRounds: [9, 4, 2],
      activeEffects: "{}",
    });

    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["NEW", "MID"]);
    assert.deepEqual(rounds(restored), [9, 4]);
    assert.equal(rounds(restored).length, hand(restored).length);
  });

  it("drops the oldest card on disconnect and keeps the new card's earnedRound", async () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 2;
    award(room, "ada", "SHIELD");
    room.state.roundCount = 4;
    award(room, "ada", "RESPIN");
    room.state.roundCount = 5;
    award(room, "ada", "TURBO");
    assert.equal(player.pendingDiscard, true);
    assert.deepEqual(rounds(player), [2, 4, 5]);

    await leaveConsented(room, "ada");
    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["RESPIN", "TURBO"]);
    assert.deepEqual(rounds(restored), [4, 5]);
    assert.equal(rounds(restored).length, hand(restored).length);
    assert.equal(restored.pendingDiscard, false);
  });
});

describe("turbo refund", () => {
  it("puts the Turbo back with its original earnedRound so it can be played again this round", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 2;
    award(room, "ada", "TURBO");

    armWheel(room, "ada");
    emit(room, "use_card", "ada", { cardId: "TURBO" });
    assert.deepEqual(hand(player), []);
    assert.equal(JSON.parse(player.activeEffects).turboEarnedRound, 2);

    spin(room, "1v1", "Hot Potato");
    assert.deepEqual(hand(player), ["TURBO"]);
    assert.deepEqual(rounds(player), [2]);
    const refunded = JSON.parse(player.activeEffects);
    assert.equal(refunded.turbo, false);
    assert.equal(refunded.turboEarnedRound, undefined);

    room.state.currentCategory = "Tapping Race";
    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), []);
    assert.equal(errors.length, 0);
    assert.equal(JSON.parse(player.activeEffects).turboEarnedRound, 2);
  });

  it("stamps a refund that has no saved round as earned this round", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.roundCount = 5;
    armWheel(room, "ada");
    award(room, "ada", "SHIELD");
    player.activeEffects = JSON.stringify({ turbo: true, doublePoints: true });

    spin(room, "1v1", "Hot Potato");
    assert.deepEqual(hand(player), ["SHIELD", "TURBO"]);
    assert.deepEqual(rounds(player), [6, 6]);
    const fx = JSON.parse(player.activeEffects);
    assert.equal(fx.turbo, false);
    assert.equal(fx.doublePoints, true);
    assert.equal(fx.turboEarnedRound, undefined);

    room.state.currentCategory = "Tapping Race";
    const errors: Sent[] = [];
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["SHIELD", "TURBO"]);
    assert.equal(lastError(errors).earnedRound, 6);

    room.state.roundCount = 6;
    emit(room, "use_card", "ada", { cardId: "TURBO" }, errors);
    assert.deepEqual(hand(player), ["SHIELD"]);
    assert.deepEqual(rounds(player), [6]);
  });

  it("does not change earnedRounds when a refund would be a 4th card", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    room.state.phase = "resolution";
    room.state.roundCount = 4;
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    award(room, "ada", "WILD CARD");
    player.activeEffects = JSON.stringify({ turbo: true, turboEarnedRound: 1 });

    spin(room, "BR", "Simon Says");

    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "WILD CARD"]);
    assert.deepEqual(rounds(player), [4, 4, 4]);
    assert.equal(JSON.parse(player.activeEffects).turbo, false);
  });
});
