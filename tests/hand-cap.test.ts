import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Client } from "@colyseus/core";
import { LobbyRoom, HAND_CAP, PENDING_DISCARD_MS } from "../src/rooms/LobbyRoom";
import { Player } from "../src/rooms/schema/LobbyState";
import { client } from "./helpers";

/**
 * CRD-005, CRD-012, CRD-016. The server allows one temporary third card.
 * The player picks which card to drop. After 15s the oldest card (held longest)
 * is dropped. Disconnect and a cache rejoin drop the newest award instead.
 * A further award while that choice is open is skipped.
 */

type Sent = { type: string; data: unknown };

function hand(player: Player): string[] {
  return player.cards.toArray();
}

function advance(room: LobbyRoom, ms: number): void {
  const clock = room.clock as unknown as { now: () => number; currentTime: number; tick: () => void };
  const target = clock.currentTime + ms;
  clock.now = () => target;
  clock.tick();
}

function emit(room: LobbyRoom, type: string, sessionId: string, message?: unknown): void {
  const events = (room as unknown as {
    onMessageEvents: { emit: (event: string, sender: unknown, payload?: unknown) => void };
  }).onMessageEvents;
  events.emit(type, { sessionId, send() {}, enqueueRaw() {} }, message ?? {});
}

function setup(): LobbyRoom {
  const room = new LobbyRoom();
  room.onCreate({});
  return room;
}

function addPlayer(room: LobbyRoom, id: string, name: string, host = false): { player: Player; messages: Sent[] } {
  const messages: Sent[] = [];
  const player = new Player();
  player.id = id;
  player.name = name;
  player.isHost = host;
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

function award(room: LobbyRoom, id: string, cardId: string, from = id): void {
  emit(room, "dev_award_card", from, { targetPlayerId: id, cardId });
}

function overflow(cardIds: [string, string, string] = ["OLDEST", "MIDDLE", "NEWEST"]): {
  room: LobbyRoom;
  player: Player;
  messages: Sent[];
} {
  const room = setup();
  const { player, messages } = addPlayer(room, "ada", "Ada", true);
  room.state.phase = "lobby";
  for (const cardId of cardIds) award(room, "ada", cardId);
  assert.equal(player.cards.length, 3);
  assert.equal(player.pendingDiscard, true);
  return { room, player, messages };
}

describe("hand cap", () => {
  it("keeps the overflow window at 15 seconds and the cap at 2", () => {
    assert.equal(HAND_CAP, 2);
    assert.equal(PENDING_DISCARD_MS, 15_000);
  });

  it("adds cards only through awardCard", () => {
    const src = readFileSync(path.join(__dirname, "../src/rooms/LobbyRoom.ts"), "utf8");
    assert.equal([...src.matchAll(/\.cards\.push\(/g)].length, 1);
    assert.equal([...src.matchAll(/\.cards\.splice\(/g)].length, 1);
    assert.equal([...src.matchAll(/this\.awardCard\(/g)].length, 4);
  });

  it("does not open a discard while the hand is at or under the cap", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    assert.deepEqual(hand(player), ["SHIELD"]);
    assert.equal(player.pendingDiscard, false);
    assert.equal(player.pendingDiscardDeadline, 0);

    award(room, "ada", "TURBO");
    assert.deepEqual(hand(player), ["SHIELD", "TURBO"]);
    assert.equal(player.pendingDiscard, false);
    assert.equal(player.pendingDiscardDeadline, 0);
  });

  it("allows one temporary third card and records the deadline on the schema", () => {
    const before = Date.now();
    const { player, messages } = overflow();
    const after = Date.now();

    assert.deepEqual(hand(player), ["OLDEST", "MIDDLE", "NEWEST"]);
    assert.equal(player.pendingDiscard, true);
    assert.equal(player.isReady, false);
    assert.ok(player.pendingDiscardDeadline >= before + PENDING_DISCARD_MS);
    assert.ok(player.pendingDiscardDeadline <= after + PENDING_DISCARD_MS);
    assert.equal(messages.filter((entry) => entry.type === "CardAwardedEvent").length, 3);
  });

  it("skips a would-be 4th card and leaves the three cards untouched", () => {
    const { room, player, messages } = overflow();
    const deadline = player.pendingDiscardDeadline;
    const before = messages.length;

    award(room, "ada", "WILD CARD");

    assert.deepEqual(hand(player), ["OLDEST", "MIDDLE", "NEWEST"]);
    assert.equal(player.pendingDiscard, true);
    assert.equal(player.pendingDiscardDeadline, deadline);
    assert.equal(messages.length, before);
  });
});

describe("actions while over the cap", () => {
  it("ignores use_card and does not consume the card", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "RESPIN");
    award(room, "ada", "SHIELD");
    award(room, "ada", "TURBO");
    room.state.phase = "wheel";
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");

    emit(room, "use_card", "ada", { cardId: "TURBO" });
    emit(room, "use_card", "ada", { cardId: "RESPIN" });

    assert.deepEqual(hand(player), ["RESPIN", "SHIELD", "TURBO"]);
    assert.equal(player.activeEffects, "");
    assert.equal((room as unknown as { isCardLocked: boolean }).isCardLocked, false);
  });

  it("ignores use_card when the pending-discard flag is set on a 2-card hand", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    award(room, "ada", "TURBO");
    player.pendingDiscard = true;
    room.state.phase = "wheel";
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");

    emit(room, "use_card", "ada", { cardId: "TURBO" });

    assert.deepEqual(hand(player), ["SHIELD", "TURBO"]);
    assert.equal(player.activeEffects, "");
  });

  it("ignores use_card when the hand is over the cap even if the flag was cleared", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    const push = (room as unknown as { pushCard: (player: Player, cardId: string) => void }).pushCard.bind(room);
    push(player, "SHIELD");
    push(player, "RESPIN");
    push(player, "TURBO");
    assert.equal(player.pendingDiscard, false);
    room.state.phase = "wheel";
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");

    emit(room, "use_card", "ada", { cardId: "TURBO" });

    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "TURBO"]);
  });

  it("still lets a player at the cap use a card", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    award(room, "ada", "TURBO");
    room.state.phase = "wheel";
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");

    emit(room, "use_card", "ada", { cardId: "TURBO" });

    assert.deepEqual(hand(player), ["SHIELD"]);
    assert.equal(JSON.parse(player.activeEffects).turbo, true);
    const stamps = (room as unknown as { cardAcquiredAt: Map<string, number[]> }).cardAcquiredAt.get("ada");
    assert.equal(stamps?.length, player.cards.length);
  });

  it("ignores ready and checkAllReady does not treat that player as ready", () => {
    const { room, player } = overflow();
    addPlayer(room, "bea", "Bea");
    const bea = room.state.players.get("bea")!;
    bea.isReady = true;
    player.isReady = true;

    emit(room, "ready", "ada", { isReady: true });
    room.checkAllReady();

    assert.equal(player.isReady, true);
    assert.equal(room.state.phase, "lobby");
  });

  it("clears ready when the third card arrives and blocks a ready flip", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    player.isReady = true;
    room.state.phase = "lobby";

    award(room, "ada", "TURBO");
    emit(room, "ready", "ada", { isReady: true });

    assert.equal(player.isReady, false);
    assert.equal(room.state.phase, "lobby");
  });
});

describe("CRD-005 discard choice", () => {
  for (const cardIndex of [0, 1, 2]) {
    it(`drops the card at index ${cardIndex} and clears the pending discard`, () => {
      const { room, player } = overflow();
      const held = ["OLDEST", "MIDDLE", "NEWEST"];

      emit(room, "discard_card", "ada", { cardIndex });

      assert.deepEqual(hand(player), held.filter((_, index) => index !== cardIndex));
      assert.equal(player.cards.length, 2);
      assert.equal(player.pendingDiscard, false);
      assert.equal(player.pendingDiscardDeadline, 0);

      advance(room, PENDING_DISCARD_MS + 5_000);
      assert.deepEqual(hand(player), held.filter((_, index) => index !== cardIndex));
    });
  }

  it("still accepts discard_card by card id", () => {
    const { room, player } = overflow();
    emit(room, "discard_card", "ada", { cardId: "MIDDLE" });
    assert.deepEqual(hand(player), ["OLDEST", "NEWEST"]);
    assert.equal(player.pendingDiscard, false);
    assert.equal(player.pendingDiscardDeadline, 0);
  });
});

describe("15s auto-discard", () => {
  it("drops the card held longest and keeps the newly awarded card", () => {
    const { room, player } = overflow(["OLDEST", "MIDDLE", "NEWEST"]);

    advance(room, PENDING_DISCARD_MS - 1);
    assert.deepEqual(hand(player), ["OLDEST", "MIDDLE", "NEWEST"]);

    advance(room, 1);
    assert.deepEqual(hand(player), ["MIDDLE", "NEWEST"]);
    assert.equal(player.pendingDiscard, false);
    assert.equal(player.pendingDiscardDeadline, 0);
  });

  it("uses acquisition order when that is not the array order", () => {
    const { room, player } = overflow(["A", "B", "C"]);
    const stamps = (room as unknown as { cardAcquiredAt: Map<string, number[]> }).cardAcquiredAt.get("ada");
    assert.ok(stamps);
    stamps[0] = 30;
    stamps[1] = 10;
    stamps[2] = 20;

    advance(room, PENDING_DISCARD_MS);
    assert.deepEqual(hand(player), ["A", "C"]);
  });

  it("does not change another player's hand", () => {
    const { room, player } = overflow();
    const { player: bea } = addPlayer(room, "bea", "Bea", true);
    award(room, "bea", "SHIELD", "bea");
    award(room, "bea", "RESPIN", "bea");

    advance(room, PENDING_DISCARD_MS);
    assert.deepEqual(hand(player), ["MIDDLE", "NEWEST"]);
    assert.deepEqual(hand(bea), ["SHIELD", "RESPIN"]);
    assert.equal(bea.pendingDiscard, false);
  });

  it("can award again once the oldest card has been dropped", () => {
    const { room, player } = overflow();
    advance(room, PENDING_DISCARD_MS);
    award(room, "ada", "WILD CARD");
    assert.deepEqual(hand(player), ["MIDDLE", "NEWEST", "WILD CARD"]);
    assert.equal(player.pendingDiscard, true);
  });
});

describe("CRD-012 / CRD-016 reconnect", () => {
  it("drops the newest card on disconnect and restores a 2-card hand", async () => {
    const { room, player } = overflow(["OLDEST", "MIDDLE", "NEWEST"]);
    player.score = 9;
    player.drinks = 2;

    await room.onLeave(client("ada"), true);

    assert.equal(room.state.players.has("ada"), false);
    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["OLDEST", "MIDDLE"]);
    assert.equal(restored.pendingDiscard, false);
    assert.equal(restored.pendingDiscardDeadline, 0);
    assert.equal(restored.score, 9);
    assert.equal(restored.drinks, 2);
    assert.equal(restored.cards.length <= 2, true);
  });

  it("keeps a chosen hand of 2 across disconnect", async () => {
    const { room, player } = overflow();
    emit(room, "discard_card", "ada", { cardIndex: 2 });
    assert.deepEqual(hand(player), ["OLDEST", "MIDDLE"]);

    await room.onLeave(client("ada"), true);
    room.onJoin(client("ada-2"), { name: "Ada" });
    assert.deepEqual(hand(room.state.players.get("ada-2")!), ["OLDEST", "MIDDLE"]);
  });

  it("drops the newest cached card even when it is not the last index", () => {
    const room = setup();
    (room as unknown as {
      disconnectedPlayersCache: Map<string, { score: number; drinks: number; cards: string[]; cardAcquiredAt: number[]; activeEffects: string }>;
    }).disconnectedPlayersCache.set("ada", {
      score: 4,
      drinks: 1,
      cards: ["NEW", "MID", "OLD"],
      cardAcquiredAt: [30, 20, 10],
      activeEffects: "{\"keep\":true}",
    });

    room.onJoin(client("ada-2"), { name: "Ada" });
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["MID", "OLD"]);
    assert.equal(restored.pendingDiscard, false);
    assert.equal(restored.score, 4);
    assert.equal(restored.activeEffects, "{\"keep\":true}");
  });

  it("drops the newest card when rejoining a disconnected session that still holds 3", () => {
    const room = setup();
    const stale = new Player();
    stale.id = "old";
    stale.name = "Ada";
    stale.isConnected = false;
    stale.score = 3;
    room.state.players.set("old", stale);
    const push = (room as unknown as { pushCard: (player: Player, cardId: string, acquiredAt?: number) => void }).pushCard.bind(room);
    push(stale, "NEW", 30);
    push(stale, "MID", 20);
    push(stale, "OLD", 10);

    room.onJoin(client("ada-2"), { name: "Ada" });

    assert.equal(room.state.players.has("old"), false);
    const restored = room.state.players.get("ada-2");
    assert.ok(restored);
    assert.deepEqual(hand(restored), ["MID", "OLD"]);
    assert.equal(restored.pendingDiscard, false);
    assert.equal(restored.score, 3);
  });
});

describe("round drop and turbo refund", () => {
  it("routes a round drop through the same cap", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");

    room.distributeSpecialtyCards();
    assert.equal(player.cards.length, 3);
    assert.equal(player.pendingDiscard, true);
    assert.equal(player.cards[0], "SHIELD");
    assert.equal(player.cards[1], "RESPIN");

    const held = hand(player);
    room.distributeSpecialtyCards();
    assert.deepEqual(hand(player), held);
  });

  it("refunds TURBO onto a 2-card hand as the temporary third card", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    award(room, "ada", "RESPIN");
    player.activeEffects = JSON.stringify({ turbo: true, doublePoints: true });

    room.forceWheelPhase("1v1", "Hot Potato", ["ada"]);

    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "TURBO"]);
    assert.equal(player.pendingDiscard, true);
    const fx = JSON.parse(player.activeEffects);
    assert.equal(fx.turbo, false);
    assert.equal(fx.doublePoints, true);
  });

  it("skips a TURBO refund that would be a 4th card", () => {
    const { room, player } = overflow(["SHIELD", "RESPIN", "WILD CARD"]);
    player.activeEffects = JSON.stringify({ turbo: true });

    room.forceWheelPhase("BR", "Simon Says", ["ada"]);

    assert.deepEqual(hand(player), ["SHIELD", "RESPIN", "WILD CARD"]);
    assert.equal(JSON.parse(player.activeEffects).turbo, false);
  });

  it("does not refund TURBO for a category that can use it", () => {
    const room = setup();
    const { player } = addPlayer(room, "ada", "Ada", true);
    award(room, "ada", "SHIELD");
    player.activeEffects = JSON.stringify({ turbo: true });

    room.forceWheelPhase("1v1", "Tapping Race", ["ada"]);

    assert.deepEqual(hand(player), ["SHIELD"]);
    assert.equal(JSON.parse(player.activeEffects).turbo, true);
    assert.equal(player.pendingDiscard, false);
  });
});

describe("after the player picks", () => {
  it("lets them ready and use a remaining card", () => {
    const { room, player } = overflow(["SHIELD", "RESPIN", "TURBO"]);
    emit(room, "discard_card", "ada", { cardIndex: 0 });
    assert.deepEqual(hand(player), ["RESPIN", "TURBO"]);

    room.state.phase = "wheel";
    room.state.currentCategory = "Tapping Race";
    room.state.selectedPlayers.push("ada");
    emit(room, "use_card", "ada", { cardId: "TURBO" });
    assert.deepEqual(hand(player), ["RESPIN"]);

    room.state.phase = "lobby";
    emit(room, "ready", "ada", { isReady: true });
    assert.equal(room.state.phase, "chart");
    assert.equal(player.isReady, false);
  });
});
