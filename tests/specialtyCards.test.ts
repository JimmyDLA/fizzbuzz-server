import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Client } from "@colyseus/core";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { LobbyState } from "../src/rooms/schema/LobbyState";
import {
  CARDS_ROSTER,
  SPECIALTY_CARD_DROP_WEIGHTS,
  SPECIALTY_CARD_RARITY,
  specialtyCardDropPool,
  specialtyCardRarity,
} from "../src/rooms/specialtyCards";
import { makeState, player, type TestPlayer } from "./helpers";

/**
 * CRD-003: the rarest card in a drop goes to last place.
 * Order is Wild Card (Legendary) > Double Points (Epic) > Shield and Turbo (Rare) > Respin (Common).
 * Other players still receive whatever cards remain. That assignment is unchanged.
 */

const RARITY_ORDER = ["WILD CARD", "DOUBLE POINTS", "SHIELD", "TURBO", "RESPIN"] as const;

function slotFor(cardId: string): number {
  const pool = specialtyCardDropPool();
  const index = pool.indexOf(cardId);
  assert.ok(index >= 0, `${cardId} is in the drop pool`);
  return (index + 0.5) / pool.length;
}

function withRandom(values: number[], fn: () => void): void {
  const real = Math.random;
  let index = 0;
  Math.random = () => values[index++] ?? 0;
  try {
    fn();
  } finally {
    Math.random = real;
  }
}

function party(count: number, overrides: Record<string, Partial<TestPlayer>> = {}): TestPlayer[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `p${i}`;
    return {
      id,
      name: `Player ${i}`,
      score: i,
      drinks: 0,
      ...overrides[id],
    };
  });
}

interface Award {
  sessionId: string;
  cardId: string;
  reason: string;
}

function distribute(players: TestPlayer[], draws: string[]): { state: LobbyState; awards: Award[] } {
  const state = makeState({ type: "BR", players });
  const room = new LobbyRoom();
  room.setState(state);
  const awards: Award[] = [];
  for (const spec of players) {
    room.clients.push({
      sessionId: spec.id,
      send(_type: string, message: { cardId: string; reason: string }) {
        awards.push({ sessionId: spec.id, cardId: message.cardId, reason: message.reason });
      },
    } as Client);
  }
  withRandom(draws.map(slotFor), () => room.distributeSpecialtyCards());
  return { state, awards };
}

function cardIds(state: LobbyState): string[] {
  const ids: string[] = [];
  state.players.forEach((entry) => ids.push(...entry.cards.toArray()));
  return ids;
}

describe("specialty card tiers and drop weights", () => {
  it("uses four tiers, with Wild Card rarest and Respin most common", () => {
    const ranks = CARDS_ROSTER.map((card) => card.rarity);
    assert.deepEqual(new Set(ranks), new Set([
      SPECIALTY_CARD_RARITY.LEGENDARY,
      SPECIALTY_CARD_RARITY.EPIC,
      SPECIALTY_CARD_RARITY.RARE,
      SPECIALTY_CARD_RARITY.COMMON,
    ]));
    assert.equal(specialtyCardRarity("WILD CARD"), SPECIALTY_CARD_RARITY.LEGENDARY);
    assert.equal(specialtyCardRarity("DOUBLE POINTS"), SPECIALTY_CARD_RARITY.EPIC);
    assert.equal(specialtyCardRarity("SHIELD"), SPECIALTY_CARD_RARITY.RARE);
    assert.equal(specialtyCardRarity("TURBO"), SPECIALTY_CARD_RARITY.RARE);
    assert.equal(specialtyCardRarity("RESPIN"), SPECIALTY_CARD_RARITY.COMMON);
    assert.equal(specialtyCardRarity("SHIELD"), specialtyCardRarity("TURBO"));
    assert.ok(SPECIALTY_CARD_RARITY.LEGENDARY < SPECIALTY_CARD_RARITY.EPIC);
    assert.ok(SPECIALTY_CARD_RARITY.EPIC < SPECIALTY_CARD_RARITY.RARE);
    assert.ok(SPECIALTY_CARD_RARITY.RARE < SPECIALTY_CARD_RARITY.COMMON);
    assert.equal(specialtyCardRarity("UNKNOWN"), SPECIALTY_CARD_RARITY.COMMON);

    const sorted = [...RARITY_ORDER].sort((a, b) => specialtyCardRarity(a) - specialtyCardRarity(b));
    assert.deepEqual(sorted, [...RARITY_ORDER]);
  });

  it("drops cards from SPECIALTY_CARD_DROP_WEIGHTS (5/3/3/1/1), with Shield rarer than Respin", () => {
    assert.deepEqual(SPECIALTY_CARD_DROP_WEIGHTS, {
      RESPIN: 5,
      SHIELD: 3,
      TURBO: 3,
      "DOUBLE POINTS": 1,
      "WILD CARD": 1,
    });
    assert.ok(SPECIALTY_CARD_DROP_WEIGHTS.SHIELD < SPECIALTY_CARD_DROP_WEIGHTS.RESPIN);

    const pool = specialtyCardDropPool();
    assert.equal(pool.length, 13);
    for (const card of CARDS_ROSTER) {
      const copies = pool.filter((id) => id === card.id).length;
      assert.equal(copies, SPECIALTY_CARD_DROP_WEIGHTS[card.id]);
    }
  });
});

describe("CRD-003 rarest card goes to last place", () => {
  it("gives Wild Card to last place when the drop also contains a more common card", () => {
    const { state, awards } = distribute(party(8), ["RESPIN", "TURBO", "DOUBLE POINTS", "WILD CARD"]);

    assert.deepEqual(player(state, "p0").cards.toArray(), ["WILD CARD"]);
    assert.deepEqual(
      awards.filter((award) => award.reason === "last_place"),
      [{ sessionId: "p0", cardId: "WILD CARD", reason: "last_place" }],
    );
    assert.deepEqual(cardIds(state).sort(), ["DOUBLE POINTS", "RESPIN", "TURBO", "WILD CARD"].sort());
    const rewards = awards.filter((award) => award.reason === "round_reward");
    assert.deepEqual(
      rewards.map((award) => award.cardId).sort(),
      ["DOUBLE POINTS", "RESPIN", "TURBO"].sort(),
    );
    assert.ok(rewards.every((award) => award.sessionId !== "p0"));
  });

  it("gives Double Points to last place when it is the rarest card in the drop", () => {
    const { state, awards } = distribute(party(4), ["RESPIN", "DOUBLE POINTS"]);

    assert.deepEqual(player(state, "p0").cards.toArray(), ["DOUBLE POINTS"]);
    assert.equal(awards.find((award) => award.reason === "last_place")?.cardId, "DOUBLE POINTS");
    assert.deepEqual(cardIds(state).sort(), ["DOUBLE POINTS", "RESPIN"].sort());
  });

  it("gives Shield to last place ahead of Respin", () => {
    const { state } = distribute(party(4), ["RESPIN", "SHIELD"]);
    assert.deepEqual(player(state, "p0").cards.toArray(), ["SHIELD"]);
    assert.equal(cardIds(state).filter((id) => id !== "SHIELD").join(","), "RESPIN");
  });

  it("gives Turbo to last place ahead of Respin", () => {
    const { state } = distribute(party(4), ["RESPIN", "TURBO"]);
    assert.deepEqual(player(state, "p0").cards.toArray(), ["TURBO"]);
  });

  it("treats Shield and Turbo as the same tier", () => {
    const shieldFirst = distribute(party(4), ["SHIELD", "TURBO"]);
    const turboFirst = distribute(party(4), ["TURBO", "SHIELD"]);

    assert.equal(specialtyCardRarity(player(shieldFirst.state, "p0").cards[0]), SPECIALTY_CARD_RARITY.RARE);
    assert.equal(specialtyCardRarity(player(turboFirst.state, "p0").cards[0]), SPECIALTY_CARD_RARITY.RARE);
    assert.deepEqual(cardIds(shieldFirst.state).sort(), ["SHIELD", "TURBO"]);
    assert.deepEqual(cardIds(turboFirst.state).sort(), ["SHIELD", "TURBO"]);
  });

  it("uses the worse score, then more drinks, to choose last place", () => {
    const { state } = distribute(
      [
        { id: "leader", name: "Ada", score: 9, drinks: 0 },
        { id: "tied-few-drinks", name: "Bea", score: 2, drinks: 0 },
        { id: "tied-many-drinks", name: "Cal", score: 2, drinks: 4 },
        { id: "mid", name: "Dee", score: 6, drinks: 1 },
      ],
      ["RESPIN", "WILD CARD"],
    );

    assert.deepEqual(player(state, "tied-many-drinks").cards.toArray(), ["WILD CARD"]);
    assert.deepEqual(player(state, "tied-few-drinks").cards.toArray(), []);
  });

  it("does not give the rarest card to a disconnected player", () => {
    const { state, awards } = distribute(
      [
        { id: "gone", name: "Ada", score: 0, drinks: 9, connected: false },
        { id: "last", name: "Bea", score: 1, drinks: 0 },
        { id: "mid", name: "Cal", score: 4, drinks: 0 },
        { id: "lead", name: "Dee", score: 8, drinks: 0 },
        { id: "top", name: "Eve", score: 10, drinks: 0 },
      ],
      ["SHIELD", "WILD CARD"],
    );

    assert.deepEqual(player(state, "gone").cards.toArray(), []);
    assert.deepEqual(player(state, "last").cards.toArray(), ["WILD CARD"]);
    assert.ok(awards.every((award) => award.sessionId !== "gone"));
  });

  it("still awards the rarest card when resolution reaches a third round", () => {
    const state = makeState({ type: "BR", players: party(4) });
    state.roundCount = 2;
    const room = new LobbyRoom();
    room.setState(state);
    withRandom([slotFor("RESPIN"), slotFor("WILD CARD")], () => room.startResolutionPhase());

    assert.equal(state.roundCount, 3);
    assert.equal(state.phase, "resolution");
    assert.deepEqual(player(state, "p0").cards.toArray(), ["WILD CARD"]);
  });
});
