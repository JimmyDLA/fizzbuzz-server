import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloseCode, type Client } from "@colyseus/core";
import { HotPotato } from "../src/games/HotPotato";
import { ScreenPainting } from "../src/games/ScreenPainting";
import { TappingRace } from "../src/games/TappingRace";
import {
  BETTING_PAYOUT_EVENT,
  BETTING_ROUND_EVENT,
  type BettingPayoutPayload,
  type BettingRoundPayload,
  isBettingRound,
  splitPot,
  wagerForPoints,
} from "../src/rooms/betting";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { Player } from "../src/rooms/schema/LobbyState";

/**
 * Every 5th round stakes min(3, points), forces Battle Royale, and pays the
 * pot by rank instead of +3. Drinks still come from the mini-game.
 */

const RANK_TABLE: Record<number, number[]> = {
  2: [4, 2],
  3: [5, 3, 1],
  4: [5, 4, 2, 1],
  5: [5, 4, 3, 2, 1],
  6: [5, 4, 3, 3, 2, 1],
  8: [5, 5, 4, 3, 3, 2, 1, 1],
  12: [6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0],
};

interface Broadcast {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  sent: Array<{ type: string; payload: unknown }>;
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
  room.disconnect = (() => Promise.resolve()) as LobbyRoom["disconnect"];
  return { room, broadcasts };
}

function addPlayer(
  room: LobbyRoom,
  id: string,
  options: { score?: number; host?: boolean } = {},
): FakeClient {
  const player = new Player();
  player.id = id;
  player.name = id;
  player.isHost = options.host ?? false;
  player.isConnected = true;
  player.score = options.score ?? 0;
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

function ready(room: LobbyRoom, client: FakeClient): void {
  emit(room, "ready", client, { isReady: true });
}

function enterChart(room: LobbyRoom, clients: FakeClient[]): void {
  for (const client of clients) ready(room, client);
  assert.equal(room.state.phase, "chart");
}

function spin(room: LobbyRoom, clients: FakeClient[]): void {
  for (const client of clients) ready(room, client);
  assert.equal(room.state.phase, "wheel");
}

function leaveResolution(room: LobbyRoom, clients: FakeClient[]): void {
  room.state.phase = "resolution";
  for (const id of room.state.selectedPlayers.toArray()) {
    const player = room.state.players.get(id);
    if (!player?.isConnected) continue;
    const client = clients.find((entry) => entry.sessionId === id);
    assert.ok(client, `selected player ${id} has a client`);
    ready(room, client);
    if (room.state.phase !== "resolution") return;
  }
}

/** Chart → wheel → resolution, with no mini-game result in between. */
function playUnresolvedRounds(room: LobbyRoom, clients: FakeClient[], count: number): void {
  for (let offset = 0; offset < count; offset += 1) {
    spin(room, clients);
    leaveResolution(room, clients);
  }
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

function events<T>(broadcasts: Broadcast[], type: string): T[] {
  return broadcasts.filter((entry) => entry.type === type).map((entry) => entry.payload as T);
}

function distinctPlacements(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `p${index + 1}`,
    standing: count - index,
  }));
}

describe("betting round detection", () => {
  it("is every positive multiple of 5, including a final round", () => {
    for (const round of [0, 1, 2, 3, 4, 6, 9, 11, 14, 16, -5, 5.5]) {
      assert.equal(isBettingRound(round), false, `round ${round}`);
    }
    for (const round of [5, 10, 15, 20, 25, 30, 40, 50]) {
      assert.equal(isBettingRound(round), true, `round ${round}`);
    }
  });

  it("shows the banner on the chart before the spin, and only then takes the stakes", () => {
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 8 });
    const bea = addPlayer(room, "bea", { score: 2 });
    enterChart(room, [ada, bea]);
    assert.equal(room.state.isBettingRound, false);
    assert.equal(room.state.bettingPot, 0);

    playUnresolvedRounds(room, [ada, bea], 4);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 5);
    assert.equal(room.state.isBettingRound, true);
    assert.equal(room.state.bettingPot, 0);
    assert.equal(room.state.players.get("ada")?.score, 8);
    assert.equal(room.state.players.get("bea")?.score, 2);
    assert.equal(events(broadcasts, BETTING_ROUND_EVENT).length, 0);

    spin(room, [ada, bea]);
    assert.equal(room.state.roundCount, 5);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.bettingPot, 5);
    assert.equal(room.state.players.get("ada")?.score, 5);
    assert.equal(room.state.players.get("ada")?.betWager, 3);
    assert.equal(room.state.players.get("ada")?.betNet, -3);
    assert.equal(room.state.players.get("bea")?.score, 0);
    assert.equal(room.state.players.get("bea")?.betWager, 2);
    assert.deepEqual(room.state.selectedPlayers.toArray().slice().sort(), ["ada", "bea"]);
    const [opened] = events<BettingRoundPayload>(broadcasts, BETTING_ROUND_EVENT);
    assert.equal(opened.roundCount, 5);
    assert.equal(opened.pot, 5);
    assert.equal(opened.mode, "BR");
    assert.equal(opened.wagers.reduce((sum, entry) => sum + entry.wager, 0), 5);
  });
});

describe("wagers", () => {
  it("caps the stake at 3 and at the points the player has, including 0", () => {
    assert.equal(wagerForPoints(0), 0);
    assert.equal(wagerForPoints(-4), 0);
    assert.equal(wagerForPoints(Number.NaN), 0);
    assert.equal(wagerForPoints(Number.POSITIVE_INFINITY), 0);
    assert.equal(wagerForPoints(1), 1);
    assert.equal(wagerForPoints(2), 2);
    assert.equal(wagerForPoints(2.9), 2);
    assert.equal(wagerForPoints(3), 3);
    assert.equal(wagerForPoints(4), 3);
    assert.equal(wagerForPoints(50), 3);
  });

  it("takes 0 from a broke player and still ranks them into the pot", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 0 });
    addPlayer(room, "bea", { score: 1 });
    addPlayer(room, "cal", { score: 9 });
    room.state.roundCount = 5;
    room.state.players.get("ada")!.gameScore = 30;
    room.state.players.get("bea")!.gameScore = 20;
    room.state.players.get("cal")!.gameScore = 10;

    assert.equal(room.startWheelPhase(), true);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.bettingPot, 4);
    assert.equal(room.state.players.get("ada")?.betWager, 0);
    assert.equal(room.state.players.get("ada")?.score, 0);
    assert.equal(room.state.players.get("bea")?.betWager, 1);
    assert.equal(room.state.players.get("bea")?.score, 0);
    assert.equal(room.state.players.get("cal")?.betWager, 3);
    assert.equal(room.state.players.get("cal")?.score, 6);

    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    // Ranked 1st, 2nd, 3rd against a pot of 4 → 2, 1, 1. No +3 on top.
    assert.equal(room.state.players.get("ada")?.score, 2);
    assert.equal(room.state.players.get("ada")?.betPayout, 2);
    assert.equal(room.state.players.get("ada")?.betNet, 2);
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("ada")?.drinks, 0);
    assert.equal(room.state.players.get("bea")?.score, 1);
    assert.equal(room.state.players.get("bea")?.betPayout, 1);
    assert.equal(room.state.players.get("bea")?.drinks, 1);
    assert.equal(room.state.players.get("cal")?.score, 7);
    assert.equal(room.state.players.get("cal")?.betPayout, 1);
    assert.equal(room.state.players.get("cal")?.betNet, -2);
    assert.equal(room.state.players.get("cal")?.drinks, 1);
    assert.equal(room.state.bettingRefunded, false);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "payout");
    assert.equal(paid.refunded, false);
    assert.equal(paid.payouts.reduce((sum, entry) => sum + entry.payout, 0), 4);
  });
});

describe("pot split", () => {
  it("matches the rank table for 2, 3, 4, 5, 6, 8, and 12 players", () => {
    for (const [countText, expected] of Object.entries(RANK_TABLE)) {
      const count = Number(countText);
      const shares = splitPot(distinctPlacements(count), count * 3);
      assert.deepEqual(shares.map((share) => share.payout), expected, `${count} players`);
      assert.deepEqual(shares.map((share) => share.rank), expected.map((_, index) => index + 1));
      assert.equal(shares.reduce((sum, share) => sum + share.payout, 0), count * 3);
    }
  });

  it("gives an equal remainder to the better rank, then to earlier input order", () => {
    // 1st and 3rd both have remainder 0.5 and one point is left. 1st gets it: 5, 3, 1.
    const distinct = splitPot(distinctPlacements(3), 9);
    assert.deepEqual(distinct.map((share) => share.payout), [5, 3, 1]);

    // Three players tied, pot 10. Floors are 3 and one leftover point follows input order.
    const tied = splitPot(
      [
        { playerId: "a", standing: 1 },
        { playerId: "b", standing: 1 },
        { playerId: "c", standing: 1 },
      ],
      10,
    );
    assert.deepEqual(tied.map((share) => share.payout), [4, 3, 3]);
    assert.deepEqual(tied.map((share) => share.rank), [1, 1, 1]);
    assert.equal(tied.reduce((sum, share) => sum + share.payout, 0), 10);
  });

  it("averages the weights of a tie and still conserves the pot", () => {
    const shares = splitPot(
      [
        { playerId: "a", standing: 10 },
        { playerId: "b", standing: 10 },
        { playerId: "c", standing: 8 },
        { playerId: "d", standing: 6 },
        { playerId: "e", standing: 4 },
        { playerId: "f", standing: 2 },
      ],
      18,
    );
    assert.deepEqual(shares.map((share) => ({ id: share.playerId, payout: share.payout, rank: share.rank })), [
      { id: "a", payout: 5, rank: 1 },
      { id: "b", payout: 5, rank: 1 },
      { id: "c", payout: 3, rank: 3 },
      { id: "d", payout: 2, rank: 4 },
      { id: "e", payout: 2, rank: 5 },
      { id: "f", payout: 1, rank: 6 },
    ]);

    const everyone = splitPot(
      ["a", "b", "c", "d", "e", "f"].map((playerId) => ({ playerId, standing: 0 })),
      18,
    );
    assert.deepEqual(everyone.map((share) => share.payout), [3, 3, 3, 3, 3, 3]);
    assert.equal(splitPot(distinctPlacements(4), 0).every((share) => share.payout === 0), true);
  });
});

describe("betting round resolution", () => {
  it("pays the 6-player example, skips +3, and still hands out drinks", () => {
    const { room, broadcasts } = bootRoom();
    const scores = [60, 50, 40, 30, 20, 10];
    const ids = ["a", "b", "c", "d", "e", "f"];
    ids.forEach((id, index) => {
      addPlayer(room, id, { score: 9, host: index === 0 });
      room.state.players.get(id)!.gameScore = scores[index];
    });
    room.state.roundCount = 10;
    room.state.totalRounds = 10;

    assert.equal(room.startWheelPhase(), true);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.isBettingRound, true);
    assert.equal(room.state.bettingPot, 18);
    assert.equal(room.state.selectedPlayers.length, 6);

    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const expected: Record<number, number> = { 60: 5, 50: 4, 40: 3, 30: 3, 20: 2, 10: 1 };
    let payoutSum = 0;
    for (const id of ids) {
      const player = room.state.players.get(id)!;
      const payout = expected[player.gameScore];
      payoutSum += player.betPayout;
      assert.equal(player.betPayout, payout, id);
      assert.equal(player.score, 9 - 3 + payout, id);
      assert.equal(player.betNet, payout - 3, id);
      assert.equal(player.drinks, player.gameScore === 60 ? 0 : 1, id);
    }
    assert.equal(payoutSum, 18);
    assert.equal(room.state.players.get("a")?.score, 11);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "payout");
    assert.equal(paid.pot, 18);
    assert.equal(paid.refunded, false);

    room.startResolutionPhase();
    assert.equal(room.state.players.get("a")?.score, 11, "resolution does not add the normal +3");
    leaveResolution(room, room.clients as unknown as FakeClient[]);
    assert.equal(room.state.phase, "gameover");
    assert.equal(room.state.roundCount, 10);
    const podium = room.state.podium.toArray().map((entry) => ({
      place: entry.place,
      playerId: entry.playerId,
      score: entry.score,
    }));
    assert.equal(podium[0].score, 11);
    assert.ok(podium.every((entry) => entry.score !== 12));
  });

  it("shares a tied placement and does not add +3 for the player holding Double Points", () => {
    const { room } = bootRoom();
    addPlayer(room, "ada", { score: 10, host: true });
    addPlayer(room, "bea", { score: 10 });
    addPlayer(room, "cal", { score: 10 });
    addPlayer(room, "dee", { score: 10 });
    addPlayer(room, "eve", { score: 10 });
    addPlayer(room, "fin", { score: 10 });
    room.state.roundCount = 5;
    const gameScores: Record<string, number> = { ada: 10, bea: 10, cal: 8, dee: 6, eve: 4, fin: 2 };
    for (const [id, gameScore] of Object.entries(gameScores)) {
      const player = room.state.players.get(id)!;
      player.gameScore = gameScore;
    }
    room.state.players.get("ada")!.activeEffects = JSON.stringify({ doublePoints: true });
    room.state.players.get("bea")!.activeEffects = JSON.stringify({ doublePoints: true });

    room.startWheelPhase();
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    room.startResolutionPhase();

    const byScore = (gameScore: number) => {
      const found = [...room.state.players.values()].filter((player) => player.gameScore === gameScore);
      return found.map((player) => player.betPayout).sort((a, b) => b - a);
    };
    assert.deepEqual(byScore(10), [5, 5]);
    assert.deepEqual(byScore(8), [3]);
    assert.deepEqual(byScore(6), [2]);
    assert.deepEqual(byScore(4), [2]);
    assert.deepEqual(byScore(2), [1]);
    for (const id of ["ada", "bea"]) {
      const player = room.state.players.get(id)!;
      assert.equal(player.score, 10 - 3 + 5, `${id} does not get +3 or +6 on top of the pot`);
      assert.equal(player.drinks, 0);
      assert.equal(player.activeEffects, "");
    }
    assert.equal(room.state.players.get("cal")?.drinks, 1);
  });

  it("refunds every wager when nobody scores, and still applies the drinks", () => {
    const { room, broadcasts } = bootRoom();
    for (const id of ["ada", "bea", "cal"]) {
      addPlayer(room, id, { score: 4, host: id === "ada" });
    }
    room.state.roundCount = 15;
    room.startWheelPhase();
    assert.equal(room.state.bettingPot, 9);
    assert.equal(room.state.players.get("ada")?.score, 1);

    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    for (const id of ["ada", "bea", "cal"]) {
      const player = room.state.players.get(id)!;
      assert.equal(player.score, 4, id);
      assert.equal(player.betWager, 3, id);
      assert.equal(player.betPayout, 3, id);
      assert.equal(player.betNet, 0, id);
      assert.equal(player.betRank, 0, id);
      assert.equal(player.drinks, 1, id);
    }
    assert.equal(room.state.bettingRefunded, true);
    assert.equal(room.state.bettingPot, 9);
    assert.deepEqual(room.state.lastWinners.toArray(), []);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "no-action");
    assert.equal(paid.refunded, true);
    assert.equal(paid.payouts.every((entry) => entry.net === 0), true);
  });

  it("ranks Hot Potato survivors above the holder and does not also pay +3", () => {
    const { room } = bootRoom();
    for (const id of ["ada", "bea", "cal"]) {
      addPlayer(room, id, { score: 6, host: id === "ada" });
    }
    room.state.roundCount = 5;
    room.startWheelPhase();
    const holderJson = JSON.stringify({ potatoHolderId: "bea", passCount: 2 });
    room.state.selectedPlayers.forEach((id) => {
      room.state.players.get(id)!.gameData = holderJson;
    });
    room.activeGame = new HotPotato();
    room.applyActiveGameResult();

    // Survivors tie for 1st and 2nd (weights 3 and 2). Holder is last (weight 1).
    // Pot 9 → 4, 4, 1. The old +3 is not added on top.
    assert.equal(room.state.players.get("ada")?.betPayout, 4);
    assert.equal(room.state.players.get("ada")?.score, 7);
    assert.equal(room.state.players.get("ada")?.drinks, 0);
    assert.equal(room.state.players.get("cal")?.betPayout, 4);
    assert.equal(room.state.players.get("cal")?.score, 7);
    assert.equal(room.state.players.get("cal")?.drinks, 0);
    assert.equal(room.state.players.get("bea")?.betPayout, 1);
    assert.equal(room.state.players.get("bea")?.score, 4);
    assert.equal(room.state.players.get("bea")?.drinks, 1);
    assert.equal(room.state.players.get("bea")?.betRank, 3);
    assert.equal(
      (room.state.players.get("ada")?.betPayout ?? 0) + (room.state.players.get("cal")?.betPayout ?? 0) + (room.state.players.get("bea")?.betPayout ?? 0),
      9,
    );
  });

  it("splits a Screen Painting coverage tie even though only the earliest player would have scored +3", () => {
    const { room } = bootRoom();
    for (const id of ["ada", "bea", "cal"]) {
      addPlayer(room, id, { score: 5, host: id === "ada" });
    }
    room.state.roundCount = 5;
    room.startWheelPhase();
    room.state.selectedPlayers.forEach((id) => {
      room.state.players.get(id)!.gameScore = 40;
    });
    room.activeGame = new ScreenPainting();
    room.applyActiveGameResult();

    const players = ["ada", "bea", "cal"].map((id) => room.state.players.get(id)!);
    assert.deepEqual(players.map((player) => player.betPayout), [3, 3, 3]);
    assert.deepEqual(players.map((player) => player.score), [5, 5, 5]);
    assert.equal(room.state.lastWinners.length, 1);
    const winnerId = room.state.lastWinners.toArray()[0];
    for (const player of players) {
      assert.equal(player.drinks, player.id === winnerId ? 0 : 1);
    }
  });

  it("still pays +3 on a round that is not a multiple of 5", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 10, host: true });
    addPlayer(room, "bea", { score: 10 });
    room.state.roundCount = 4;
    room.state.players.get("ada")!.gameScore = 5;
    room.state.players.get("bea")!.gameScore = 1;
    room.startWheelPhase();
    assert.equal(room.state.isBettingRound, false);
    assert.equal(room.state.bettingPot, 0);
    assert.equal(room.state.players.get("ada")?.betWager, 0);
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    assert.equal(room.state.players.get("ada")?.score, 13);
    assert.equal(room.state.players.get("bea")?.score, 10);
    assert.equal(room.state.players.get("bea")?.drinks, 1);
    assert.equal(events(broadcasts, BETTING_ROUND_EVENT).length, 0);
    assert.equal(events(broadcasts, BETTING_PAYOUT_EVENT).length, 0);
  });
});

describe("Battle Royale is forced", () => {
  it("rejects a Wild Card mode switch and still lets it pick the game", () => {
    const timers = useManualTimers();
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 9 });
    const bea = addPlayer(room, "bea", { score: 9 });
    const cal = addPlayer(room, "cal", { score: 9 });
    try {
      enterChart(room, [ada, bea, cal]);
      room.state.roundCount = 4;
      assert.equal(room.forceWheelPhase("1v1", "Trivia", ["ada", "bea"]), true);
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea"]);
      assert.equal(room.state.players.get("ada")?.score, 9);
      assert.equal(room.state.bettingPot, 0);

      room.state.phase = "chart";
      room.state.roundCount = 5;
      (room as unknown as { roundInProgress: boolean }).roundInProgress = false;
      const holder = room.state.players.get("cal")!;
      holder.cards.push("WILD CARD");
      emit(room, "use_card", cal, {
        cardId: "WILD CARD",
        category: "Trivia",
        type: "1v1",
        selectedPlayers: ["ada", "bea"],
      });
      const announced = broadcasts.filter((entry) => entry.type === "CardUsedEvent").pop();
      assert.equal((announced?.payload as { forcedBattleRoyale?: boolean }).forcedBattleRoyale, true);
      assert.match(String((announced?.payload as { message?: string }).message), /Battle Royale/);

      timers.flush();
      assert.equal(room.state.phase, "wheel");
      assert.equal(room.state.currentGameType, "BR");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.deepEqual(room.state.selectedPlayers.toArray().slice().sort(), ["ada", "bea", "cal"]);
      assert.equal(room.state.bettingPot, 9);
      assert.equal(room.state.players.get("ada")?.score, 6);
      assert.equal(room.state.players.get("cal")?.score, 6);

      timers.flush();
      holder.cards.push("WILD CARD");
      emit(room, "use_card", cal, {
        cardId: "WILD CARD",
        category: "Cyclone",
        type: "2v2",
        selectedPlayers: ["ada", "bea"],
      });
      timers.flush();
      assert.equal(room.state.currentGameType, "BR");
      assert.equal(room.state.currentCategory, "Cyclone");
      assert.deepEqual(room.state.selectedPlayers.toArray().slice().sort(), ["ada", "bea", "cal"]);
      assert.equal(room.state.bettingPot, 9, "a replacement spin does not take the stake again");
      assert.equal(room.state.players.get("ada")?.score, 6);
      assert.equal(room.state.players.get("bea")?.score, 6);
      assert.equal(room.state.players.get("cal")?.score, 6);
    } finally {
      timers.restore();
    }
  });

  it("returns every stake when a betting round is aborted, so the replay charges once", async () => {
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 8 });
    const bea = addPlayer(room, "bea", { score: 8 });
    enterChart(room, [ada, bea]);
    playUnresolvedRounds(room, [ada, bea], 4);
    spin(room, [ada, bea]);
    assert.equal(room.state.roundCount, 5);
    assert.equal(room.state.players.get("ada")?.score, 5);
    assert.equal(room.state.bettingPot, 6);

    room.state.phase = "playing";
    await room.onLeave(bea as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 5);
    assert.equal(room.state.isBettingRound, true);
    assert.equal(room.state.bettingPot, 0);
    assert.equal(room.state.players.get("ada")?.score, 8);
    assert.equal(room.state.players.get("ada")?.betWager, 0);
    assert.equal(room.state.players.has("bea"), false);
    const refunds = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(refunds[refunds.length - 1].reason, "aborted");
    assert.equal(refunds[refunds.length - 1].refunded, true);

    const cal = addPlayer(room, "cal", { score: 8 });
    spin(room, [ada, cal]);
    assert.equal(room.state.roundCount, 5);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.players.get("ada")?.score, 5);
    assert.equal(room.state.players.get("ada")?.betWager, 3);
    assert.equal(room.state.bettingPot, 6);
  });
});
