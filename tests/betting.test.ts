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

function discardPending(room: LobbyRoom, client: FakeClient): void {
  const player = room.state.players.get(client.sessionId);
  if (!player?.pendingDiscard) return;
  while (player.pendingDiscard && player.cards.length > 2) {
    emit(room, "discard_card", client, { cardIndex: player.cards.length - 1 });
  }
}

function ready(room: LobbyRoom, client: FakeClient): void {
  discardPending(room, client);
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

    const lowPot = splitPot(
      [
        { playerId: "a", standing: 2 },
        { playerId: "b", standing: 2 },
        { playerId: "c", standing: 0 },
      ],
      1,
    );
    assert.deepEqual(lowPot.map((share) => share.payout), [1, 0, 0]);
    assert.equal(lowPot.reduce((sum, share) => sum + share.payout, 0), 1);

    const seven = [3, 3, 2, 1, 1, 1, 0].map((standing, index) => ({
      playerId: `p${index + 1}`,
      standing,
    }));
    const sevenShares = splitPot(seven, 7);
    assert.deepEqual(sevenShares.map((share) => share.payout), [2, 1, 1, 1, 1, 1, 0]);
    assert.equal(sevenShares.reduce((sum, share) => sum + share.payout, 0), 7);

    // Redirected leftovers rotate across the tied top group. Standings
    // 1,9,1,1,1,2,9,1,5,0,0 and pot 7 used to pile both redirects on the
    // earlier top player (3 and 1). They now share them (2 and 2).
    const qaStandings = [1, 9, 1, 1, 1, 2, 9, 1, 5, 0, 0];
    const qaShares = splitPot(
      qaStandings.map((standing, index) => ({ playerId: `p${index}`, standing })),
      7,
    );
    const qaById = Object.fromEntries(qaShares.map((share) => [share.playerId, share.payout]));
    assert.deepEqual(qaById, {
      p0: 1,
      p1: 2,
      p2: 0,
      p3: 0,
      p4: 0,
      p5: 1,
      p6: 2,
      p7: 0,
      p8: 1,
      p9: 0,
      p10: 0,
    });
    assert.deepEqual(
      qaShares.filter((share) => share.playerId === "p1" || share.playerId === "p6").map((share) => share.rank),
      [1, 1],
    );
    assert.ok(Math.abs(qaById.p1 - qaById.p6) <= 1);
    assert.equal(qaShares.reduce((sum, share) => sum + share.payout, 0), 7);

    // A remainder-pass redirect and the one-at-a-time fallback share one
    // rotation. Standings 12,12,12,12,3 and pot 2 used to pay 2,0,0,0,0.
    const fourWay = splitPot(
      [12, 12, 12, 12, 3].map((standing, index) => ({ playerId: `p${index}`, standing })),
      2,
    );
    assert.deepEqual(fourWay.map((share) => share.payout), [1, 1, 0, 0, 0]);
    assert.deepEqual(fourWay.map((share) => share.rank), [1, 1, 1, 1, 5]);
    assert.equal(fourWay.reduce((sum, share) => sum + share.payout, 0), 2);

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

  it("pays a tied 2-stake and 1-stake 1 each from pot 2 in either seat order", () => {
    const stake2First = splitPot(
      [
        { playerId: "a", standing: 1 },
        { playerId: "b", standing: 1 },
      ],
      2,
      { a: 2, b: 1 },
    );
    const stake1First = splitPot(
      [
        { playerId: "b", standing: 1 },
        { playerId: "a", standing: 1 },
      ],
      2,
      { a: 2, b: 1 },
    );
    // Weights average 3/2. Shares are 12/9 and 6/9, so the stake of 1 keeps the
    // larger remainder (6 against 3) and takes the leftover point in both orders.
    assert.deepEqual(stake2First.map((share) => share.payout), [1, 1]);
    assert.deepEqual(stake1First.map((share) => share.payout), [1, 1]);
    assert.deepEqual(stake2First.map((share) => share.playerId), ["a", "b"]);
    assert.deepEqual(stake1First.map((share) => share.playerId), ["b", "a"]);
    assert.equal(stake2First.reduce((sum, share) => sum + share.payout, 0), 2);
    assert.equal(stake1First.reduce((sum, share) => sum + share.payout, 0), 2);
  });

  it("pays the eight-player board by largest remainder inside the tie", () => {
    const standings = [3, 10, 7, 5, 10, 10, 2, 10];
    const placements = standings.map((standing, index) => ({ playerId: `p${index}`, standing }));
    const stakes = { p0: 0, p1: 3, p2: 0, p3: 0, p4: 3, p5: 3, p6: 3, p7: 2 };
    const shares = splitPot(placements, 5, stakes);
    const byId = Object.fromEntries(shares.map((share) => [share.playerId, share.payout]));
    // Tied top is p1, p4, p5, p7. Their floors are 1, 1, 1, 0. p7's remainder
    // is 130/149 and the stake-3 leaders are at 46/149, so p7 takes the tie's
    // leftover point. p6 is alone in last and is paid the other point.
    assert.deepEqual(placements.map((placement) => byId[placement.playerId]), [0, 1, 0, 0, 1, 1, 1, 1]);
    assert.equal(shares.reduce((sum, share) => sum + share.payout, 0), 5);
  });

  it("keeps equal-stake tied leaders within 1 across random boards", () => {
    let seed = 0x6d2b79f5;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 20000; trial += 1) {
      const count = 2 + Math.floor(rand() * 11);
      const placements = Array.from({ length: count }, (_, index) => ({
        playerId: `p${index}`,
        standing: Math.floor(rand() * 16),
      }));
      const pot = Math.floor(rand() * 40);
      const stake = 1 + Math.floor(rand() * 3);
      const stakes: Record<string, number> = {};
      for (const placement of placements) stakes[placement.playerId] = stake;
      for (const shares of [splitPot(placements, pot), splitPot(placements, pot, stakes)]) {
        const top = Math.max(...placements.map((placement) => placement.standing));
        const topIds = new Set(
          placements.filter((placement) => placement.standing === top).map((placement) => placement.playerId),
        );
        const pays = shares.filter((share) => topIds.has(share.playerId)).map((share) => share.payout);
        const gap = Math.max(...pays) - Math.min(...pays);
        assert.ok(
          gap <= 1,
          `trial ${trial} standings ${placements.map((placement) => placement.standing).join(",")} pot ${pot} stake ${stake} pays ${shares.map((share) => share.payout).join(",")}`,
        );
        assert.equal(shares.reduce((sum, share) => sum + share.payout, 0), pot);
      }
    }
  });

  it("pays out exactly the pot when stakes differ", () => {
    let seed = 0x6d2b79f6;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 20000; trial += 1) {
      const count = 2 + Math.floor(rand() * 11);
      const placements = Array.from({ length: count }, (_, index) => ({
        playerId: `p${index}`,
        standing: Math.floor(rand() * 16),
      }));
      const pot = Math.floor(rand() * 40);
      const stakes: Record<string, number> = {};
      // A board with every stake at 0 has no weight to divide, so redraw until
      // someone staked. The payouts of that board add up to the pot.
      do {
        for (const placement of placements) stakes[placement.playerId] = Math.floor(rand() * 4);
      } while (Object.values(stakes).every((stake) => stake === 0));
      const shares = splitPot(placements, pot, stakes);
      assert.equal(
        shares.reduce((sum, share) => sum + share.payout, 0),
        pot,
        `trial ${trial} standings ${placements.map((placement) => placement.standing).join(",")} pot ${pot} stakes ${placements.map((placement) => stakes[placement.playerId]).join(",")} pays ${shares.map((share) => share.payout).join(",")}`,
      );
    }
  });

  it("preserves payouts when tied seats move, except an exact-remainder cohort", () => {
    let seed = 0x6d2b79f7;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 5000; trial += 1) {
      const count = 2 + Math.floor(rand() * 11);
      const placements = Array.from({ length: count }, (_, index) => ({
        playerId: `p${index}`,
        standing: Math.floor(rand() * 16),
      }));
      const pot = Math.floor(rand() * 40);
      const stakes: Record<string, number> = {};
      for (const placement of placements) stakes[placement.playerId] = Math.floor(rand() * 4);
      const before = payoutsById(splitPot(placements, pot, stakes));
      const permuted = permuteTiedSeats(placements, rand);
      const after = payoutsById(splitPot(permuted, pot, stakes));
      const parts = integerShares(placements, pot, stakes);
      const stakeTotal = Object.values(stakes).reduce((sum, stake) => sum + stake, 0);
      const detail = `trial ${trial} standings ${placements.map((entry) => entry.standing).join(",")} pot ${pot} stakes ${placements.map((entry) => stakes[entry.playerId]).join(",")}`;
      if (stakeTotal > 0) {
        assert.equal(Object.values(before).reduce((sum, payout) => sum + payout, 0), pot, `${detail} sum`);
        assert.equal(Object.values(after).reduce((sum, payout) => sum + payout, 0), pot, `${detail} permuted sum`);
      }
      const byStanding = new Map<number, typeof placements>();
      for (const placement of placements) {
        const group = byStanding.get(placement.standing) ?? [];
        group.push(placement);
        byStanding.set(placement.standing, group);
      }
      for (const group of byStanding.values()) {
        const cohorts = new Map<number, string[]>();
        for (const placement of group) {
          if (stakes[placement.playerId] <= 0) continue;
          const remainder = parts.get(placement.playerId)?.remainder ?? 0;
          const ids = cohorts.get(remainder) ?? [];
          ids.push(placement.playerId);
          cohorts.set(remainder, ids);
        }
        const inCohort = new Set<string>();
        for (const ids of cohorts.values()) {
          if (ids.length < 2) continue;
          ids.forEach((id) => inCohort.add(id));
          const extras = (payouts: Record<string, number>) => ids
            .map((id) => payouts[id] - (parts.get(id)?.floor ?? 0))
            .sort((left, right) => left - right)
            .join(",");
          assert.equal(extras(after), extras(before), `${detail} cohort ${ids.join("+")}`);
        }
        for (const placement of group) {
          if (inCohort.has(placement.playerId)) continue;
          assert.equal(after[placement.playerId], before[placement.playerId], `${detail} ${placement.playerId}`);
        }
      }
    }
  });
});

function payoutsById(shares: readonly { playerId: string; payout: number }[]): Record<string, number> {
  return Object.fromEntries(shares.map((share) => [share.playerId, share.payout]));
}

function permuteTiedSeats(
  placements: readonly { playerId: string; standing: number }[],
  rand: () => number,
): Array<{ playerId: string; standing: number }> {
  const next = placements.map((placement) => ({ ...placement }));
  const groups = new Map<number, number[]>();
  next.forEach((placement, index) => {
    const seats = groups.get(placement.standing) ?? [];
    seats.push(index);
    groups.set(placement.standing, seats);
  });
  for (const seats of groups.values()) {
    for (let cursor = seats.length - 1; cursor > 0; cursor -= 1) {
      const swap = Math.floor(rand() * (cursor + 1));
      const left = seats[cursor];
      const right = seats[swap];
      const hold = next[left];
      next[left] = next[right];
      next[right] = hold;
    }
  }
  return next;
}

/** Floor and remainder from the initial stake-weighted split. Seat order inside a tie does not change either. */
function integerShares(
  placements: readonly { playerId: string; standing: number }[],
  pot: number,
  stakes: Readonly<Record<string, number>>,
): Map<string, { floor: number; remainder: number }> {
  const shares = new Map<string, { floor: number; remainder: number }>();
  const n = placements.length;
  const safePot = Number.isFinite(pot) ? Math.max(0, Math.floor(pot)) : 0;
  const ordered = placements.map((placement, order) => ({
    playerId: placement.playerId,
    standing: placement.standing,
    order,
    stake: Math.max(0, Math.floor(stakes[placement.playerId] ?? 0)),
  }));
  ordered.sort((a, b) => {
    if (a.standing !== b.standing) return b.standing - a.standing;
    return a.order - b.order;
  });
  const members: Array<{ playerId: string; stake: number; weightNum: number; weightDen: number }> = [];
  let index = 0;
  while (index < ordered.length) {
    let end = index + 1;
    while (end < ordered.length && ordered[end].standing === ordered[index].standing) end += 1;
    const rank = index + 1;
    const groupSize = end - index;
    let weightSum = 0;
    for (let offset = 0; offset < groupSize; offset += 1) {
      weightSum += n - (rank + offset) + 1;
    }
    const divisor = gcdInt(weightSum, groupSize);
    for (let cursor = index; cursor < end; cursor += 1) {
      members.push({
        playerId: ordered[cursor].playerId,
        stake: ordered[cursor].stake,
        weightNum: weightSum / divisor,
        weightDen: groupSize / divisor,
      });
    }
    index = end;
  }
  const scale = members.reduce((acc, member) => lcmInt(acc, member.weightDen), 1);
  const scaledWeight = members.map((member) => member.stake * member.weightNum * (scale / member.weightDen));
  const weightTotal = scaledWeight.reduce((sum, value) => sum + value, 0);
  members.forEach((member, memberIndex) => {
    const numerator = safePot * scaledWeight[memberIndex];
    shares.set(member.playerId, {
      floor: weightTotal === 0 || safePot === 0 ? 0 : Math.floor(numerator / weightTotal),
      remainder: weightTotal === 0 || safePot === 0 ? 0 : numerator % weightTotal,
    });
  });
  return shares;
}

function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function lcmInt(a: number, b: number): number {
  return (a / gcdInt(a, b)) * b;
}

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

  it("pays the last Simon Says player when everyone still has a zero score", async () => {
    const { room } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 0 });
    const bea = addPlayer(room, "bea", { score: 0 });
    const cal = addPlayer(room, "cal", { score: 0 });
    const dee = addPlayer(room, "dee", { score: 0 });
    room.state.roundCount = 0;
    assert.equal(room.forceWheelPhase("BR", "Simon Says", ["ada", "bea", "cal", "dee"]), true);
    await eliminateThenLeave(room, [ada, bea, cal, dee]);

    assert.deepEqual(room.state.lastWinners.toArray(), ["ada"]);
    assert.equal(room.state.players.get("ada")?.score, 3);
    assert.equal(room.state.players.get("ada")?.drinks, 0);
    assert.equal(room.state.players.get("cal")?.score, 0);
    assert.equal(room.state.players.get("cal")?.drinks, 1);
    assert.equal(room.state.bettingRefunded, false);
    assert.equal(room.state.bettingPot, 0);
  });

  it("does not refund a betting Simon Says round won by outlasting", async () => {
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 6 });
    const bea = addPlayer(room, "bea", { score: 6 });
    const cal = addPlayer(room, "cal", { score: 6 });
    const dee = addPlayer(room, "dee", { score: 6 });
    room.state.roundCount = 4;
    assert.equal(room.forceWheelPhase("BR", "Simon Says", ["ada", "bea", "cal", "dee"]), true);
    assert.equal(room.state.bettingPot, 12);
    await eliminateThenLeave(room, [ada, bea, cal, dee]);

    assert.deepEqual(room.state.lastWinners.toArray(), ["ada"]);
    assert.equal(room.state.bettingRefunded, false);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "payout");
    assert.equal(paid.refunded, false);
    assert.equal(paid.payouts.reduce((sum, entry) => sum + entry.payout, 0), 12);
    // Cal was knocked out at 0 rounds. The disconnect that ends the game must
    // rank that elimination under the survivor, the same as a normal knockout.
    assert.equal(room.state.players.get("ada")?.gameScore, 1);
    assert.equal(room.state.players.get("cal")?.gameScore, 0);
    assert.equal(room.state.players.get("ada")?.betRank, 1);
    assert.equal(room.state.players.get("cal")?.betRank, 2);
    assert.equal(room.state.players.get("ada")?.betPayout, 8);
    assert.equal(room.state.players.get("cal")?.betPayout, 4);
    assert.equal(room.state.players.get("ada")?.drinks, 0);
    assert.equal(room.state.players.get("cal")?.drinks, 1);
    assert.equal(room.state.players.get("ada")?.score, 11);
    assert.equal(room.state.players.get("cal")?.score, 7);
  });

  it("ranks a disconnect knockout strictly below the Simon Says survivor", async () => {
    const { room } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 6 });
    const bea = addPlayer(room, "bea", { score: 6 });
    const cal = addPlayer(room, "cal", { score: 6 });
    const dee = addPlayer(room, "dee", { score: 6 });
    room.state.roundCount = 4;
    assert.equal(room.forceWheelPhase("BR", "Simon Says", ["ada", "bea", "cal", "dee"]), true);
    await eliminateThenLeave(room, [ada, bea, cal, dee]);

    const survivor = room.state.players.get("ada")!;
    const eliminated = room.state.players.get("cal")!;
    assert.ok(survivor.betRank < eliminated.betRank);
    assert.ok(survivor.betPayout > eliminated.betPayout);
    assert.equal(survivor.drinks, 0);
    assert.equal(eliminated.drinks, 1);
    assert.equal(survivor.betPayout + eliminated.betPayout, 12);
    assert.equal(room.state.bettingRefunded, false);
  });
});

async function eliminateThenLeave(room: LobbyRoom, clients: FakeClient[]): Promise<void> {
  const [ada, bea, cal, dee] = clients;
  const game = new SimonSays();
  room.activeGame = game;
  room.state.phase = "playing";
  game.onInit(room.state);
  const holder = room.state.players.get(room.state.selectedPlayers[0])!;
  const data = JSON.parse(holder.gameData);
  data.phase = "input";
  room.state.selectedPlayers.forEach((id) => {
    room.state.players.get(id)!.gameData = JSON.stringify(data);
  });
  game.onMessage(client(cal.sessionId), { action: "tap", color: 99 }, room.state);
  room.state.phase = "playing";
  await room.onLeave(bea as unknown as Client, CloseCode.CONSENTED);
  await room.onLeave(dee as unknown as Client, CloseCode.CONSENTED);
  room.applyActiveGameResult();
  assert.equal(ada.sessionId, "ada");
}

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

  it("swaps the selected seat when a player rejoins during betting resolution", async () => {
    const { room } = bootRoom();
    const ada = joinNamed(room, "ada", "Ada");
    joinNamed(room, "bea", "Bea");
    room.state.roundCount = 15;
    room.state.phase = "resolution";
    room.state.isBettingRound = true;
    room.state.selectedPlayers.push("ada", "bea");
    const pending = beginGrace(room, ada);
    const ada2 = joinNamed(room, "ada2", "Ada");

    assert.equal(room.state.selectedPlayers.includes("ada"), false);
    assert.equal(room.state.selectedPlayers.includes("ada2"), true);
    assert.equal(room.state.players.has("ada"), false);
    assert.equal(room.state.players.get("ada2")?.name, "Ada");
    await finishGrace(room, ada, pending, false);
  });

  it("ranks a grace seat 1st on a refund when another player has left", async () => {
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 9 });
    const bea = addPlayer(room, "bea", { score: 6 });
    const cal = addPlayer(room, "cal", { score: 9 });
    const dee = addPlayer(room, "dee", { score: 3 });
    room.state.roundCount = 4;
    assert.equal(room.startWheelPhase(), true);
    assert.equal(room.state.bettingPot, 12);
    room.state.phase = "playing";

    await room.onLeave(cal as unknown as Client, CloseCode.CONSENTED);
    const pending = beginGrace(room, bea);
    assert.equal(room.state.players.get("bea")?.isConnected, false);
    assert.equal(room.state.players.has("bea"), true);
    assert.equal(room.state.players.has("cal"), false);

    room.state.currentCategory = "Tapping Race";
    room.activeGame = new TappingRace();
    room.applyActiveGameResult();

    const waiting = room.state.players.get("bea")!;
    const stayer = room.state.players.get("ada")!;
    const other = room.state.players.get("dee")!;
    assert.equal(waiting.betRank, 1);
    assert.equal(stayer.betRank, 1);
    assert.equal(other.betRank, 1);
    assert.equal(waiting.score, 7);
    assert.equal(stayer.score, 10);
    assert.equal(other.score, 4);
    assert.equal(waiting.betPayout, 4);
    assert.equal(stayer.betPayout + waiting.betPayout + other.betPayout, 12);
    assert.equal(room.state.bettingRefunded, true);
    const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
    assert.equal(paid.reason, "no-action");
    assert.equal(paid.payouts.find((entry) => entry.playerId === "bea")?.rank, 1);
    assert.equal(ada.sessionId, "ada");

    await finishGrace(room, bea, pending, false);
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

interface ManualClock {
  tick(seconds?: number): void;
  restore(): void;
}

/** Room loop and RPS deadlines share one clock, so a no-pick throw can be advanced without waiting. */
function installManualClock(): ManualClock {
  let now = 5_000_000;
  const realNow = Date.now;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let nextId = 1;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, { cb: () => void; at: number }>();

  Date.now = () => now;
  global.setInterval = ((callback: TimerHandler) => {
    const id = nextId++;
    intervals.set(id, () => {
      if (typeof callback === "function") callback();
    });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  global.clearInterval = ((id?: number) => {
    if (typeof id === "number") intervals.delete(id);
  }) as unknown as typeof clearInterval;
  global.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const id = nextId++;
    timeouts.set(id, {
      cb: () => {
        if (typeof callback === "function") callback();
      },
      at: now + (delay ?? 0),
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  global.clearTimeout = ((id?: number) => {
    if (typeof id === "number") timeouts.delete(id);
  }) as unknown as typeof clearTimeout;

  return {
    tick(seconds = 1) {
      for (let step = 0; step < seconds; step += 1) {
        now += 1000;
        for (const callback of [...intervals.values()]) callback();
        for (const [id, job] of [...timeouts.entries()]) {
          if (job.at <= now) {
            timeouts.delete(id);
            job.cb();
          }
        }
      }
    },
    restore() {
      Date.now = realNow;
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
  };
}

function rpsWord(room: LobbyRoom): string {
  const id = room.state.selectedPlayers[0];
  if (!id) return "";
  try {
    return JSON.parse(room.state.players.get(id)?.gameData || "{}").animationWord || "";
  } catch {
    return "";
  }
}

function sumScores(room: LobbyRoom): number {
  let sum = 0;
  room.state.players.forEach((player) => {
    sum += player.score;
  });
  return sum;
}

function tickUntil(clock: ManualClock, ready: () => boolean, maxTicks: number, label: string): void {
  for (let i = 0; i < maxTicks; i += 1) {
    if (ready()) return;
    clock.tick(1);
  }
  assert.equal(ready(), true, label);
}

describe("Rock Paper Scissors no-pick rounds", () => {
  function openRps(betting: boolean) {
    const { room, broadcasts } = bootRoom();
    const ada = addPlayer(room, "ada", { host: true, score: 9 });
    const bea = addPlayer(room, "bea", { score: 9 });
    if (betting) room.state.roundCount = 4;
    assert.equal(room.forceWheelPhase("BR", "Rock Paper Scissors", ["ada", "bea"]), true);
    const clock = installManualClock();
    room.startPlayingPhase();
    room.state.timer = 1;
    return { room, broadcasts, ada, bea, clock };
  }

  function reachSuddenDeath(room: LobbyRoom, clock: ManualClock): void {
    tickUntil(clock, () => rpsWord(room) === "SUDDEN DEATH!", 8, "regulation with no picks did not reach sudden death");
    assert.equal(room.state.phase, "playing");
  }

  function reachNoPickReplay(room: LobbyRoom, clock: ManualClock): void {
    if (rpsWord(room) === "NO PICK! TRY AGAIN...") clock.tick(1);
    tickUntil(clock, () => rpsWord(room) === "NO PICK! TRY AGAIN...", 20, "sudden-death throw with no picks did not replay");
  }

  it("moves a regulation round with no picks into sudden death", () => {
    const { room, clock } = openRps(false);
    try {
      reachSuddenDeath(room, clock);
      assert.equal(room.state.players.get("ada")?.score, 9);
      assert.equal(room.state.players.get("bea")?.drinks, 0);
      assert.notEqual(room.state.phase, "resolution");
    } finally {
      room.onDispose();
      clock.restore();
    }
  });

  it("replays a sudden-death throw when nobody picks, with no cap", () => {
    const { room, clock } = openRps(false);
    try {
      reachSuddenDeath(room, clock);
      for (let replay = 0; replay < 3; replay += 1) {
        reachNoPickReplay(room, clock);
        assert.equal(room.state.phase, "playing");
        assert.equal(room.state.players.get("ada")?.score, 9);
        assert.equal(room.state.players.get("bea")?.score, 9);
        assert.equal(room.state.players.get("ada")?.drinks, 0);
      }
    } finally {
      room.onDispose();
      clock.restore();
    }
  });

  it("pays a betting round that reached sudden death with no regulation picks", () => {
    const { room, broadcasts, ada, clock } = openRps(true);
    try {
      assert.equal(room.state.bettingPot, 6);
      assert.equal(sumScores(room), 12);
      reachSuddenDeath(room, clock);
      emit(room, "game_action", ada, { action: "pick", choice: "rock" });
      tickUntil(
        clock,
        () => events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT).length === 1,
        40,
        "betting round never paid after a sudden-death winner",
      );
      const [paid] = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
      assert.equal(paid.reason, "payout");
      assert.equal(paid.refunded, false);
      assert.equal(paid.payouts.reduce((sum, entry) => sum + entry.payout, 0), 6);
      assert.equal(room.state.players.get("ada")?.score, 10);
      assert.equal(room.state.players.get("bea")?.score, 8);
      assert.equal(room.state.players.get("bea")?.drinks, 1);
      assert.equal(room.state.players.get("ada")?.drinks, 0);
      assert.equal(sumScores(room), 18);
      const locked = room.state.players.get("ada")!.score + room.state.players.get("bea")!.score;
      room.onDispose();
      assert.equal(room.state.players.get("ada")!.score + room.state.players.get("bea")!.score, locked);
    } finally {
      room.onDispose();
      clock.restore();
    }
  });

  it("refunds a betting sudden-death throw that nobody picks when the room is disposed", () => {
    const { room, broadcasts, clock } = openRps(true);
    try {
      assert.equal(sumScores(room), 12);
      reachSuddenDeath(room, clock);
      reachNoPickReplay(room, clock);
      assert.equal(room.state.phase, "playing");
      assert.equal(room.state.players.get("ada")?.betWager, 3);
      room.onDispose();
      assert.equal(room.state.players.get("ada")?.score, 9);
      assert.equal(room.state.players.get("bea")?.score, 9);
      assert.equal(room.state.players.get("ada")?.betWager, 0);
      assert.equal(room.state.players.get("bea")?.betWager, 0);
      assert.equal(room.state.bettingPot, 0);
      assert.equal(sumScores(room), 18);
      const refunds = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
      assert.equal(refunds[refunds.length - 1].reason, "aborted");
      assert.equal(refunds[refunds.length - 1].refunded, true);
      room.onDispose();
      assert.equal(room.state.players.get("ada")?.score, 9);
      assert.equal(room.state.players.get("bea")?.score, 9);
    } finally {
      room.onDispose();
      clock.restore();
    }
  });

  it("refunds locked stakes when everyone leaves during a no-pick hang", async () => {
    const { room, broadcasts, ada, bea, clock } = openRps(true);
    try {
      reachSuddenDeath(room, clock);
      reachNoPickReplay(room, clock);
      assert.equal(room.state.players.get("ada")?.score, 6);
      assert.equal(room.state.players.get("bea")?.score, 6);
      await room.onLeave(bea as unknown as Client, CloseCode.CONSENTED);
      await room.onLeave(ada as unknown as Client, CloseCode.CONSENTED);
      const cache = (room as unknown as {
        disconnectedPlayersCache: Map<string, { score: number }>;
      }).disconnectedPlayersCache;
      assert.equal(cache.get("ada")?.score, 9);
      assert.equal(cache.get("bea")?.score, 9);
      assert.equal(room.state.bettingPot, 0);
      assert.equal(room.state.players.has("ada"), false);
      assert.equal(room.state.players.has("bea"), false);
      const refunds = events<BettingPayoutPayload>(broadcasts, BETTING_PAYOUT_EVENT);
      assert.equal(refunds[refunds.length - 1].reason, "aborted");
      assert.equal(refunds[refunds.length - 1].refunded, true);
    } finally {
      room.onDispose();
      clock.restore();
    }
  });
});
