import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloseCode, type Client } from "@colyseus/core";
import { HotPotato } from "../src/games/HotPotato";
import { LumberCut } from "../src/games/LumberCut";
import { MathProblem } from "../src/games/MathProblem";
import { ScreenPainting } from "../src/games/ScreenPainting";
import { SimonSays } from "../src/games/SimonSays";
import { TappingRace } from "../src/games/TappingRace";
import { Trivia } from "../src/games/Trivia";
import { client } from "./helpers";
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
    room.startResolutionPhase();
    leaveResolution(room, clients);
  }
}

function beginGrace(room: LobbyRoom, client: FakeClient): Promise<unknown> {
  (client as FakeClient & { reconnectionToken?: string }).reconnectionToken = `${client.sessionId}-grace`;
  return room.onLeave(client as unknown as Client, 1006);
}

async function finishGrace(
  room: LobbyRoom,
  client: FakeClient,
  pending: Promise<unknown>,
  reconnect: boolean,
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
    assert.equal(room.state.roundCount, 4);
    assert.equal(room.state.isBettingRound, true);
    assert.equal(room.state.bettingPot, 0);
    assert.equal(room.state.players.get("ada")?.score, 8);
    assert.equal(room.state.players.get("bea")?.score, 2);
    assert.equal(events(broadcasts, BETTING_ROUND_EVENT).length, 0);

    spin(room, [ada, bea]);
    assert.equal(room.state.roundCount, 4, "the wheel does not advance roundCount");
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
    room.state.roundCount = 4;
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

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    // Stakes 0, 1, 3 and pot 4. Weights 3, 2, 1. Shares 0, 2, 2. A 0 stake pays 0.
    assert.equal(room.state.players.get("ada")?.score, 0);
    assert.equal(room.state.players.get("ada")?.betPayout, 0);
    assert.equal(room.state.players.get("ada")?.betNet, 0);
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("ada")?.drinks, 0);
    assert.equal(room.state.players.get("bea")?.score, 2);
    assert.equal(room.state.players.get("bea")?.betPayout, 2);
    assert.equal(room.state.players.get("bea")?.drinks, 1);
    assert.equal(room.state.players.get("cal")?.score, 8);
    assert.equal(room.state.players.get("cal")?.betPayout, 2);
    assert.equal(room.state.players.get("cal")?.betNet, -1);
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

  it("pays a two-way tie for 1st the same amount in both split modes", () => {
    const tiedFirst = [
      { playerId: "a", standing: 2 },
      { playerId: "b", standing: 2 },
      { playerId: "c", standing: 0 },
    ];
    const equalStakes = { a: 1, b: 1, c: 1 };
    for (const stakes of [undefined, equalStakes]) {
      const small = splitPot(tiedFirst, 3, stakes);
      const large = splitPot(tiedFirst, 6, stakes);
      // a and b share (3+2)/2 = 2.5. Pot 3 leaves c the larger remainder, so c takes the point.
      assert.deepEqual(small.map((share) => share.payout), [1, 1, 1]);
      // Pot 6 floors to 2, 2, 1. c's remainder is 0, so the pass skips c. The tie does not
      // fit the last point, and the fallback gives it to a.
      assert.deepEqual(large.map((share) => share.payout), [3, 2, 1]);
      assert.deepEqual(small.map((share) => share.rank), [1, 1, 3]);
      assert.equal(small.reduce((sum, share) => sum + share.payout, 0), 3);
      assert.equal(large.reduce((sum, share) => sum + share.payout, 0), 6);
    }

    // Unequal stakes stay proportional. a and b are tied, but a staked more.
    const uneven = splitPot(tiedFirst, 6, { a: 3, b: 1, c: 1 });
    assert.deepEqual(uneven.map((share) => share.payout), [4, 1, 1]);
    assert.equal(uneven.reduce((sum, share) => sum + share.payout, 0), 6);
  });

  it("keeps a three-way tie equal, then uses earliest selection for a leftover the group cannot share", () => {
    const three = [
      { playerId: "a", standing: 1 },
      { playerId: "b", standing: 1 },
      { playerId: "c", standing: 1 },
    ];
    assert.deepEqual(splitPot(three, 3).map((share) => share.payout), [1, 1, 1]);
    const fallback = splitPot(three, 4);
    assert.deepEqual(fallback.map((share) => share.payout), [2, 1, 1]);
    assert.deepEqual(fallback.map((share) => share.rank), [1, 1, 1]);
    assert.deepEqual(splitPot(three, 4, { a: 2, b: 2, c: 2 }).map((share) => share.payout), [2, 1, 1]);
    assert.deepEqual(splitPot(three, 10).map((share) => share.payout), [4, 3, 3]);
    assert.equal(splitPot(three, 4).reduce((sum, share) => sum + share.payout, 0), 4);

    // A 0 stake is not eligible, so the leftover falls through to the earlier staker.
    const skipped = splitPot(three, 5, { a: 1, b: 0, c: 1 });
    assert.deepEqual(skipped.map((share) => share.payout), [3, 0, 2]);
    assert.equal(skipped.reduce((sum, share) => sum + share.payout, 0), 5);
  });

  it("keeps a middle tie equal unless no rank group can take the leftover", () => {
    const middle = [
      { playerId: "a", standing: 10 },
      { playerId: "b", standing: 5 },
      { playerId: "c", standing: 5 },
      { playerId: "d", standing: 1 },
    ];
    const shares = splitPot(middle, 8);
    assert.deepEqual(shares.map((share) => share.payout), [3, 2, 2, 1]);
    assert.deepEqual(shares.map((share) => share.rank), [1, 2, 2, 4]);
    assert.equal(shares.reduce((sum, share) => sum + share.payout, 0), 8);
    const weighted = splitPot(middle, 8, { a: 1, b: 1, c: 1, d: 1 });
    assert.deepEqual(weighted.map((share) => share.payout), [3, 2, 2, 1]);

    // Two pairs average their place weights and share a remainder. The better rank
    // goes first, so the top pair takes the two points it can share. The last point
    // does not cover the lower pair, and the earlier of that pair takes it.
    const pairs = splitPot(
      [
        { playerId: "a", standing: 4 },
        { playerId: "b", standing: 4 },
        { playerId: "c", standing: 1 },
        { playerId: "d", standing: 1 },
      ],
      5,
    );
    assert.deepEqual(pairs.map((share) => share.payout), [2, 2, 1, 0]);
    assert.deepEqual(pairs.map((share) => share.rank), [1, 1, 3, 3]);
    assert.equal(pairs.reduce((sum, share) => sum + share.payout, 0), 5);
  });

  it("averages the weights of a tie and pays a 2nd-place tie 4, 1, 0 from stakes 3, 2, 0", () => {
    const second = splitPot(
      [
        { playerId: "a", standing: 2 },
        { playerId: "b", standing: 1 },
        { playerId: "c", standing: 1 },
      ],
      5,
      { a: 3, b: 2, c: 0 },
    );
    assert.deepEqual(second.map((share) => share.payout), [4, 1, 0]);
    assert.deepEqual(second.map((share) => share.rank), [1, 2, 2]);
    assert.equal(second.reduce((sum, share) => sum + share.payout, 0), 5);
  });

  it("uses the average place weight for a tie and still conserves the pot", () => {
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

  it("pays the exact share when every remainder is 0", () => {
    const tied = splitPot(
      [
        { playerId: "a", standing: 1 },
        { playerId: "b", standing: 1 },
        { playerId: "c", standing: 1 },
      ],
      6,
    );
    assert.deepEqual(tied.map((share) => share.payout), [2, 2, 2]);
    assert.equal(tied.reduce((sum, share) => sum + share.payout, 0), 6);

    const distinct = splitPot(distinctPlacements(2), 6);
    assert.deepEqual(distinct.map((share) => share.payout), [4, 2]);
    assert.equal(distinct.reduce((sum, share) => sum + share.payout, 0), 6);
  });

  it("weights the share by the stake and pays 0 to a player who staked 0", () => {
    for (const count of [2, 5, 6, 8, 12]) {
      const stakes: Record<string, number> = {};
      for (let index = 1; index <= count; index += 1) stakes[`p${index}`] = 3;
      const shares = splitPot(distinctPlacements(count), count * 3, stakes);
      assert.deepEqual(shares.map((share) => share.payout), RANK_TABLE[count], `${count} equal stakes`);
      assert.equal(shares.reduce((sum, share) => sum + share.payout, 0), count * 3);
    }

    const mixed = splitPot(
      [
        { playerId: "a", standing: 4 },
        { playerId: "b", standing: 3 },
        { playerId: "c", standing: 2 },
        { playerId: "d", standing: 1 },
      ],
      6,
      { a: 3, b: 2, c: 1, d: 0 },
    );
    assert.deepEqual(mixed.map((share) => share.payout), [4, 2, 0, 0]);
    assert.equal(mixed.reduce((sum, share) => sum + share.payout, 0), 6);

    const tied = splitPot(
      [
        { playerId: "a", standing: 5 },
        { playerId: "b", standing: 5 },
        { playerId: "c", standing: 1 },
      ],
      7,
      { a: 3, b: 1, c: 3 },
    );
    assert.deepEqual(tied.map((share) => ({ id: share.playerId, payout: share.payout, rank: share.rank })), [
      { id: "a", payout: 4, rank: 1 },
      { id: "b", payout: 1, rank: 1 },
      { id: "c", payout: 2, rank: 3 },
    ]);
    assert.equal(tied.reduce((sum, share) => sum + share.payout, 0), 7);

    const none = splitPot(distinctPlacements(3), 0, { p1: 0, p2: 0, p3: 0 });
    assert.deepEqual(none.map((share) => share.payout), [0, 0, 0]);
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
    room.state.roundCount = 9;
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
    room.state.roundCount = 4;
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
    room.state.roundCount = 14;
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
      assert.equal(player.betRank, 1, id);
      assert.equal(player.drinks, 1, id);
    }
    assert.equal(room.state.bettingRefunded, true);
    assert.equal(room.state.bettingPot, 9);
    assert.deepEqual(room.state.lastWinners.toArray(), []);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "no-action");
    assert.equal(paid.refunded, true);
    assert.equal(paid.payouts.every((entry) => entry.net === 0 && entry.rank === 1), true);
  });

  it("ranks Hot Potato survivors above the holder and does not also pay +3", () => {
    const { room } = bootRoom();
    for (const id of ["ada", "bea", "cal"]) {
      addPlayer(room, id, { score: 6, host: id === "ada" });
    }
    room.state.roundCount = 4;
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
    room.state.roundCount = 4;
    room.startWheelPhase();
    room.state.currentCategory = "Screen Painting";
    room.state.selectedPlayers.forEach((id) => {
      room.state.players.get(id)!.gameScore = 40;
    });
    room.activeGame = new ScreenPainting();
    room.applyActiveGameResult();

    const players = ["ada", "bea", "cal"].map((id) => room.state.players.get(id)!);
    assert.deepEqual(players.map((player) => player.betPayout), [3, 3, 3]);
    assert.deepEqual(players.map((player) => player.score), [5, 5, 5]);
    assert.equal(room.state.lastWinners.length, 1);
    for (const player of players) {
      assert.equal(player.drinks, 0, "a tie for the top score does not drink");
    }
  });

  it("ranks Math and Trivia from the timeline, not a missing leaderboard", () => {
    for (const Game of [MathProblem, Trivia]) {
      const { room } = bootRoom();
      const answers = [5, 3, 1, 0];
      ["ada", "bea", "cal", "dee"].forEach((id, index) => {
        addPlayer(room, id, { score: 10, host: index === 0 });
        room.state.players.get(id)!.gameScore = answers[index];
      });
      room.state.roundCount = 4;
      room.startWheelPhase();
      room.state.currentCategory = Game === MathProblem ? "Math Problem" : "Trivia";
      room.activeGame = new Game();
      room.applyActiveGameResult();
      const expected = [5, 4, 2, 1];
      ["ada", "bea", "cal", "dee"].forEach((id, index) => {
        const player = room.state.players.get(id)!;
        assert.equal(player.betPayout, expected[index], id);
        assert.equal(player.score, 10 - 3 + expected[index], id);
        assert.equal(player.drinks, index === 0 ? 0 : 1, id);
      });
    }
  });

  it("still pays +3 on a round that is not a multiple of 5", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 10, host: true });
    addPlayer(room, "bea", { score: 10 });
    room.state.roundCount = 3;
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

function assertNoActionRefund(
  room: LobbyRoom,
  broadcasts: Broadcast[],
  startingScores: Record<string, number>,
): void {
  const paid = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].reason, "no-action");
  assert.equal(paid[0].refunded, true);
  assert.equal(room.state.bettingRefunded, true);
  assert.deepEqual(room.state.lastWinners.toArray(), []);
  for (const [id, score] of Object.entries(startingScores)) {
    const player = room.state.players.get(id)!;
    assert.equal(player.score, score, `${id} gets their own wager back`);
    assert.equal(player.betPayout, player.betWager, id);
    assert.equal(player.betNet, 0, id);
    assert.equal(player.drinks, 1, id);
  }
  assert.deepEqual(
    paid[0].payouts.map((entry) => entry.payout).sort((a, b) => a - b),
    Object.keys(startingScores).map((id) => room.state.players.get(id)!.betWager).sort((a, b) => a - b),
  );
}

describe("no-action betting refunds", () => {
  it("pays 4, 1, 0 when only the winner cut and the other two tie on stakes 3, 2, 0", () => {
    const { room } = bootRoom();
    const ada = addPlayer(room, "ada", { score: 3, host: true });
    const bea = addPlayer(room, "bea", { score: 2 });
    const cal = addPlayer(room, "cal", { score: 0 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    const game = new LumberCut();
    game.onInit(room.state);
    game.onMessage(client(ada.sessionId), { action: "pull", side: "left" }, room.state);
    game.onMessage(client(ada.sessionId), { action: "pull", side: "right" }, room.state);
    room.activeGame = game;
    room.applyActiveGameResult();

    assert.equal(room.state.players.get("ada")?.betPayout, 4);
    assert.equal(room.state.players.get("bea")?.betPayout, 1);
    assert.equal(room.state.players.get("cal")?.betPayout, 0);
    assert.equal(room.state.players.get("ada")?.score, 4);
    assert.equal(room.state.players.get("bea")?.score, 1);
    assert.equal(room.state.players.get("cal")?.score, 0);
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("bea")?.betRank, 2);
    assert.equal(room.state.players.get("cal")?.betRank, 2);
    assert.equal(room.state.bettingPot, 5);
    assert.equal(room.state.bettingRefunded, false);
    assert.equal(
      (room.state.players.get("ada")?.betPayout ?? 0)
        + (room.state.players.get("bea")?.betPayout ?? 0)
        + (room.state.players.get("cal")?.betPayout ?? 0),
      5,
    );
    assert.ok(bea.sessionId && cal.sessionId);
  });

  it("refunds a Lumber Cut where nobody cut", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 9, host: true });
    addPlayer(room, "bea", { score: 1 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    const game = new LumberCut();
    game.onInit(room.state);
    room.activeGame = game;
    room.applyActiveGameResult();

    assertNoActionRefund(room, broadcasts, { ada: 9, bea: 1 });
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("bea")?.betRank, 1);
    const data = JSON.parse(room.state.players.get(room.state.selectedPlayers[0])!.gameData);
    assert.equal(data.teams.every((team: { pairs: number }) => team.pairs === 0), true);
  });

  it("refunds a Lumber Cut where the only pull never finishes a pair", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 9, host: true });
    addPlayer(room, "bea", { score: 1 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    const game = new LumberCut();
    game.onInit(room.state);
    const puller = room.state.selectedPlayers[0];
    game.onMessage(client(puller), { action: "pull", side: "left" }, room.state);
    room.activeGame = game;
    room.applyActiveGameResult();

    assertNoActionRefund(room, broadcasts, { ada: 9, bea: 1 });
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("bea")?.betRank, 1);
    const data = JSON.parse(room.state.players.get(puller)!.gameData);
    assert.equal(data.teams.every((team: { pairs: number }) => team.pairs === 0), true);
  });

  it("refunds a Turbo point on a blank Math or Trivia board", () => {
    for (const Game of [MathProblem, Trivia]) {
      const { room, broadcasts } = bootRoom();
      addPlayer(room, "ada", { score: 9, host: true });
      addPlayer(room, "bea", { score: 1 });
      room.state.roundCount = 4;
      assert.equal(room.startWheelPhase(), true);
      room.state.currentCategory = Game === MathProblem ? "Math Problem" : "Trivia";
      room.state.players.get("ada")!.activeEffects = JSON.stringify({ turbo: true });
      room.activeGame = new Game();
      room.applyActiveGameResult();

      assertNoActionRefund(room, broadcasts, { ada: 9, bea: 1 });
      assert.equal(room.state.players.get("ada")?.betRank, 1);
      assert.equal(room.state.players.get("bea")?.betRank, 1);
      assert.equal(room.state.players.get("ada")?.gameScore, 0);
      assert.equal(room.state.players.get("bea")?.gameScore, 0);
    }
  });

  it("refunds a Simon Says timeout at round 0", () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { score: 9, host: true });
    addPlayer(room, "bea", { score: 1 });
    addPlayer(room, "cal", { score: 4 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    const ids = room.state.selectedPlayers.toArray();
    const script = JSON.stringify({
      winners: [],
      activePlayers: ids,
      currentRound: 1,
    });
    for (const id of ids) {
      const player = room.state.players.get(id)!;
      player.gameData = script;
      player.gameScore = 0;
    }
    room.activeGame = new SimonSays();
    room.applyActiveGameResult();

    assertNoActionRefund(room, broadcasts, { ada: 9, bea: 1, cal: 4 });
    for (const id of ["ada", "bea", "cal"]) assert.equal(room.state.players.get(id)?.betRank, 1, id);
    assert.deepEqual(room.state.lastLosers.toArray().slice().sort(), ["ada", "bea", "cal"]);
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
      room.state.roundCount = 3;
      assert.equal(room.forceWheelPhase("1v1", "Trivia", ["ada", "bea"]), true);
      assert.equal(room.state.currentGameType, "1v1");
      assert.equal(room.state.currentCategory, "Trivia");
      assert.deepEqual(room.state.selectedPlayers.toArray(), ["ada", "bea"]);
      assert.equal(room.state.players.get("ada")?.score, 9);
      assert.equal(room.state.bettingPot, 0);

      room.state.phase = "chart";
      room.state.roundCount = 4;
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
    assert.equal(room.state.roundCount, 4);
    assert.equal(room.state.players.get("ada")?.score, 5);
    assert.equal(room.state.bettingPot, 6);

    room.state.phase = "playing";
    await room.onLeave(bea as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.roundCount, 4);
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
    assert.equal(room.state.roundCount, 4);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.players.get("ada")?.score, 5);
    assert.equal(room.state.players.get("ada")?.betWager, 3);
    assert.equal(room.state.bettingPot, 6);
  });
});

describe("grace, abort, and non-betting rounds", () => {
  it("does not pay +3 for a non-betting Turbo point on a blank Math board", () => {
    const { room } = bootRoom();
    addPlayer(room, "ada", { score: 9, host: true });
    addPlayer(room, "bea", { score: 4 });
    room.state.roundCount = 3;
    room.startWheelPhase();
    assert.equal(room.state.isBettingRound, false);
    room.state.currentCategory = "Math Problem";
    room.state.players.get("ada")!.activeEffects = JSON.stringify({ turbo: true });
    room.activeGame = new MathProblem();
    room.applyActiveGameResult();
    assert.equal(room.state.players.get("ada")?.gameScore, 0);
    assert.equal(room.state.players.get("ada")?.score, 9);
    assert.equal(room.state.players.get("ada")?.drinks, 1);
    assert.equal(room.state.players.get("ada")?.betWager, 0);
    assert.equal(room.state.players.get("bea")?.score, 4);
    assert.equal(room.state.players.get("bea")?.drinks, 1);
    assert.equal(room.state.bettingPot, 0);
  });

  it("keeps a grace stake in the pot and does not stake or pay again on reconnect", async () => {
    const { room } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 9 });
    const bea = addPlayer(room, "bea", { score: 9 });
    const cal = addPlayer(room, "cal", { score: 9 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    assert.equal(room.state.bettingPot, 9);
    room.state.phase = "playing";

    const pending = beginGrace(room, cal);
    assert.equal(room.state.phase, "playing");
    assert.equal(room.state.players.get("cal")?.isConnected, false);
    assert.equal(room.state.players.has("cal"), true);
    assert.equal(room.state.players.get("cal")?.score, 6);
    assert.equal(room.state.players.get("cal")?.betWager, 3);
    assert.equal(room.state.bettingPot, 9);

    await finishGrace(room, cal, pending, true);
    assert.equal(room.state.players.get("cal")?.isConnected, true);
    assert.equal(room.state.players.get("cal")?.score, 6);
    assert.equal(room.state.players.get("cal")?.betWager, 3);
    assert.equal(room.state.bettingPot, 9);

    room.state.players.get("ada")!.gameScore = 5;
    room.state.players.get("bea")!.gameScore = 3;
    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const returned = room.state.players.get("cal")!;
    assert.equal(returned.betRank, 3);
    assert.equal(returned.betPayout, 1);
    assert.equal(returned.score, 7);
    assert.equal(returned.drinks, 1);
    assert.equal(
      ["ada", "bea", "cal"].reduce((sum, id) => sum + (room.state.players.get(id)?.betPayout ?? 0), 0),
      9,
    );
  });

  it("keeps a leaver's stake in a paid pot and pays it to the players still ranked", async () => {
    const { room } = bootRoom();
    addPlayer(room, "ada", { host: true, score: 9 });
    addPlayer(room, "bea", { score: 9 });
    const cal = addPlayer(room, "cal", { score: 9 });
    room.state.roundCount = 4;
    room.startWheelPhase();
    assert.equal(room.state.bettingPot, 9);
    room.state.phase = "playing";
    await room.onLeave(cal as unknown as Client, CloseCode.CONSENTED);
    assert.equal(room.state.players.has("cal"), false);
    assert.equal(room.state.bettingPot, 9);

    room.state.players.get("ada")!.gameScore = 8;
    room.state.players.get("bea")!.gameScore = 2;
    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    assert.equal(room.state.players.get("ada")?.betPayout, 6);
    assert.equal(room.state.players.get("ada")?.score, 12);
    assert.equal(room.state.players.get("bea")?.betPayout, 3);
    assert.equal(room.state.players.get("bea")?.score, 9);
    assert.equal(
      (room.state.players.get("ada")?.betPayout ?? 0) + (room.state.players.get("bea")?.betPayout ?? 0),
      9,
    );
  });

  it("refunds a leaver's stake to the remaining seats in proportion to what they staked", async () => {
    const { room } = bootRoom();
    addPlayer(room, "ada", { host: true, score: 9 });
    addPlayer(room, "bea", { score: 1 });
    const cal = addPlayer(room, "cal", { score: 9 });
    room.state.roundCount = 4;
    room.startWheelPhase();
    const lockOrder = room.state.selectedPlayers.toArray();
    assert.equal(room.state.bettingPot, 7);
    room.state.phase = "playing";
    await room.onLeave(cal as unknown as Client, CloseCode.CONSENTED);

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const ada = room.state.players.get("ada")!;
    const bea = room.state.players.get("bea")!;
    assert.equal(room.state.bettingRefunded, true);
    assert.equal(room.state.bettingPot, 7);
    assert.equal(ada.betPayout, 5);
    assert.equal(bea.betPayout, 2);
    assert.equal(ada.score, 11);
    assert.equal(bea.score, 2);
    assert.equal(ada.drinks, 1);
    assert.equal(bea.drinks, 1);
    assert.ok(lockOrder.includes("ada") && lockOrder.includes("bea"));
  });

  it("splits a leaver's stake equally when everyone left behind staked 0", async () => {
    const { room } = bootRoom();
    addPlayer(room, "ada", { host: true, score: 0 });
    addPlayer(room, "bea", { score: 0 });
    const cal = addPlayer(room, "cal", { score: 5 });
    room.state.roundCount = 4;
    room.startWheelPhase();
    const remaining = room.state.selectedPlayers.toArray().filter((id) => id !== "cal");
    assert.equal(room.state.bettingPot, 3);
    room.state.phase = "playing";
    await room.onLeave(cal as unknown as Client, CloseCode.CONSENTED);

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const first = room.state.players.get(remaining[0])!;
    const second = room.state.players.get(remaining[1])!;
    assert.equal(first.betPayout, 2);
    assert.equal(second.betPayout, 1);
    assert.equal(first.score, 2);
    assert.equal(second.score, 1);
    assert.equal(first.betPayout + second.betPayout, 3);
    assert.equal(room.state.bettingPot, 3);
    assert.equal(room.state.bettingRefunded, true);
    assert.equal(first.betRank, 1);
    assert.equal(second.betRank, 1);
  });

  it("pays a leaver's pot by rank when everyone left behind staked 0", async () => {
    const { room, broadcasts } = bootRoom();
    addPlayer(room, "ada", { host: true, score: 0 });
    addPlayer(room, "bea", { score: 0 });
    addPlayer(room, "cal", { score: 0 });
    const dee = addPlayer(room, "dee", { score: 9 });
    room.state.roundCount = 4;
    room.startWheelPhase();
    assert.equal(room.state.bettingPot, 3);
    room.state.phase = "playing";
    await room.onLeave(dee as unknown as Client, CloseCode.CONSENTED);

    room.state.players.get("ada")!.gameScore = 1;
    room.state.players.get("bea")!.gameScore = 5;
    room.state.players.get("cal")!.gameScore = 3;
    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const ada = room.state.players.get("ada")!;
    const bea = room.state.players.get("bea")!;
    const cal = room.state.players.get("cal")!;
    assert.equal(room.state.bettingRefunded, false);
    assert.equal(bea.betRank, 1);
    assert.equal(cal.betRank, 2);
    assert.equal(ada.betRank, 3);
    assert.equal(bea.betPayout, 2);
    assert.equal(cal.betPayout, 1);
    assert.equal(ada.betPayout, 0);
    assert.equal(bea.score, 2);
    assert.equal(cal.score, 1);
    assert.equal(ada.score, 0);
    assert.equal(ada.betPayout + bea.betPayout + cal.betPayout, 3);
    assert.equal(room.state.bettingPot, 3);
    assert.equal(bea.drinks, 0);
    assert.equal(cal.drinks, 1);
    assert.equal(ada.drinks, 1);
    const hosts = [...room.state.players.values()].filter((player) => player.isHost && player.isConnected);
    assert.equal(hosts.length, 1);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "payout");
    assert.equal(paid.refunded, false);
    assert.deepEqual(
      paid.payouts.map((entry) => entry.rank),
      paid.payouts.map((entry) => room.state.players.get(entry.playerId)!.betRank),
    );
  });

  it("resets a settled pot on abort so the replay stakes from the scores already paid", async () => {
    const { room } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 9 });
    const bea = addPlayer(room, "bea", { score: 9 });
    room.state.roundCount = 4;
    room.startWheelPhase();
    room.state.players.get("ada")!.gameScore = 4;
    room.state.players.get("bea")!.gameScore = 1;
    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    assert.equal(room.state.players.get("ada")?.score, 10);
    assert.equal(room.state.players.get("bea")?.score, 8);
    assert.equal(room.state.bettingPot, 6);

    room.state.phase = "playing";
    await room.onLeave(bea as unknown as Client, CloseCode.CONSENTED);
    assert.equal(room.state.phase, "chart");
    assert.equal(room.state.bettingPot, 0);
    assert.equal(room.state.players.get("ada")?.score, 10);
    assert.equal(room.state.players.get("ada")?.betWager, 0);
    assert.equal(room.state.isBettingRound, true);

    const cal = addPlayer(room, "cal", { score: 9 });
    spin(room, [ada, cal]);
    assert.equal(room.state.currentGameType, "BR");
    assert.equal(room.state.players.get("ada")?.score, 7);
    assert.equal(room.state.players.get("ada")?.betWager, 3);
    assert.equal(room.state.players.get("cal")?.betWager, 3);
    assert.equal(room.state.bettingPot, 6);
  });

  it("keeps the host's stake when grace promotes the earliest player, then pays the pot once", async () => {
    const { room } = bootRoom();
    const ada = joinNamed(room, "ada", "Ada");
    joinNamed(room, "bea", "Bea");
    joinNamed(room, "cal", "Cal");
    for (const id of ["ada", "bea", "cal"]) room.state.players.get(id)!.score = 9;
    assert.equal(room.state.players.get("ada")?.isHost, true);
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    room.state.phase = "playing";

    const pending = beginGrace(room, ada);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    assert.equal(room.state.players.get("ada")?.isHost, false);
    assert.equal(room.state.players.get("ada")?.score, 6);
    assert.equal(room.state.bettingPot, 9);

    await finishGrace(room, ada, pending, true);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    assert.equal(room.state.players.get("ada")?.score, 6);
    assert.equal(room.state.players.get("ada")?.betWager, 3);
    assert.equal(room.state.bettingPot, 9);

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    const payout = ["ada", "bea", "cal"].reduce((sum, id) => sum + (room.state.players.get(id)?.betPayout ?? 0), 0);
    const scores = ["ada", "bea", "cal"].reduce((sum, id) => sum + (room.state.players.get(id)?.score ?? 0), 0);
    assert.equal(payout, 9);
    assert.equal(scores, 27);
  });

  it("promotes the earliest player when the host leaves and still pays that stake", async () => {
    const { room } = bootRoom();
    const ada = joinNamed(room, "ada", "Ada");
    joinNamed(room, "bea", "Bea");
    joinNamed(room, "cal", "Cal");
    for (const id of ["ada", "bea", "cal"]) room.state.players.get(id)!.score = 9;
    room.state.roundCount = 4;
    room.startWheelPhase();
    room.state.players.get("bea")!.gameScore = 5;
    room.state.players.get("cal")!.gameScore = 1;
    room.state.phase = "playing";
    await room.onLeave(ada as unknown as Client, CloseCode.CONSENTED);

    assert.equal(room.state.players.has("ada"), false);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    assert.equal(room.state.bettingPot, 9);
    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    const bea = room.state.players.get("bea")!;
    const cal = room.state.players.get("cal")!;
    assert.equal(bea.betPayout, 6);
    assert.equal(cal.betPayout, 3);
    assert.equal(bea.score + cal.score, 21);
  });

  it("moves the stake onto a name rejoin so the refund is not paid to someone else", async () => {
    const { room } = bootRoom();
    const ada = joinNamed(room, "ada", "Ada");
    joinNamed(room, "bea", "Bea");
    joinNamed(room, "cal", "Cal");
    for (const id of ["ada", "bea", "cal"]) room.state.players.get(id)!.score = 9;
    room.state.roundCount = 4;
    room.startWheelPhase();
    room.state.phase = "playing";
    const pending = beginGrace(room, ada);

    const ada2 = joinNamed(room, "ada2", "Ada");
    assert.equal(room.state.players.has("ada"), false);
    assert.equal(room.state.players.get("ada2")?.score, 6);
    assert.equal(room.state.players.get("ada2")?.betWager, 3);
    assert.equal(room.state.players.get("bea")?.isHost, true);
    await finishGrace(room, ada, pending, false);

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();
    assert.equal(room.state.players.get("ada2")?.score, 9);
    assert.equal(room.state.players.get("bea")?.score, 9);
    assert.equal(room.state.players.get("cal")?.score, 9);
    assert.equal(room.state.bettingPot, 9);
    assert.equal(ada2.sessionId, "ada2");
  });
});

function joinNamed(room: LobbyRoom, id: string, name: string): FakeClient {
  const client: FakeClient = {
    sessionId: id,
    sent: [],
    send(type, payload) {
      this.sent.push({ type, payload });
    },
    enqueueRaw() {},
  };
  room.clients.push(client as unknown as LobbyRoom["clients"][number]);
  room.onJoin(client as unknown as Client, { name });
  return client;
}
