import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloseCode } from "@colyseus/core";
import { LobbyRoom, SHIELD_DECISION_MS } from "../src/rooms/LobbyRoom";
import { DrinkChain, LobbyState, Player } from "../src/rooms/schema/LobbyState";
import { client } from "./helpers";

interface PlayerSpec {
  id: string;
  name: string;
  /** Drinks already on the counter before this resolution's losses. */
  priorDrinks?: number;
  cards?: string[];
}

function resolution(
  players: PlayerSpec[],
  losers: string[],
  type = "BR",
) {
  const state = new LobbyState();
  state.phase = "playing";
  state.currentGameType = type;
  for (const spec of players) {
    const player = new Player();
    player.id = spec.id;
    player.name = spec.name;
    player.drinks = (spec.priorDrinks ?? 0) + losers.filter((id) => id === spec.id).length;
    player.isConnected = true;
    for (const card of spec.cards ?? []) player.cards.push(card);
    state.players.set(spec.id, player);
    state.selectedPlayers.push(spec.id);
  }
  for (const id of losers) state.lastLosers.push(id);

  const room = new LobbyRoom();
  room.setState(state);
  const events: Array<{ type: string; message: Record<string, unknown> }> = [];
  (room as unknown as { broadcast: (type: string, message: Record<string, unknown>) => void }).broadcast =
    (type, message) => {
      events.push({ type, message });
    };
  room.startResolutionPhase();
  return { room, state, events };
}

function chain(state: LobbyState, id: string): DrinkChain {
  const found = state.drinkChains.get(id);
  if (!found) throw new Error(`missing drink chain for ${id}`);
  return found;
}

function drinks(state: LobbyState, id: string): number {
  const player = state.players.get(id);
  if (!player) throw new Error(`missing player ${id}`);
  return player.drinks;
}

function shields(state: LobbyState, id: string): number {
  const player = state.players.get(id);
  if (!player) throw new Error(`missing player ${id}`);
  return player.cards.toArray().filter((card) => card === "SHIELD").length;
}

function owed(state: LobbyState, id: string): number {
  return state.lastLosers.toArray().filter((loser) => loser === id).length;
}

function pass(room: LobbyRoom, from: string, to: string) {
  const result = room.applyShield(from, to);
  if (!result) throw new Error(`${from} failed to shield to ${to}`);
  return result;
}

describe("Shield chains", () => {
  it("Ana to Cy and Ben to Dee stay separate, so Dee owes 1", () => {
    const { room, state, events } = resolution(
      [
        { id: "ana", name: "Ana", cards: ["SHIELD"] },
        { id: "ben", name: "Ben", cards: ["SHIELD"] },
        { id: "cy", name: "Cy" },
        { id: "dee", name: "Dee" },
      ],
      ["ana", "ben"],
    );

    const toCy = pass(room, "ana", "cy");
    const toDee = pass(room, "ben", "dee");

    assert.equal(toCy.drinksToPass, 1);
    assert.equal(toDee.drinksToPass, 1);
    assert.equal(chain(state, "cy").drinks, 1);
    assert.equal(chain(state, "dee").drinks, 1);
    assert.equal(drinks(state, "dee"), 1);
    assert.equal(owed(state, "dee"), 1);
    assert.equal(chain(state, "cy").drinksToPass, 2);
    assert.equal(chain(state, "dee").drinksToPass, 2);
    assert.deepEqual(
      events.map((event) => event.message.drinksToPass),
      [1, 1],
    );
  });

  it("merges two chains only when both land on the same player", () => {
    const { room, state, events } = resolution(
      [
        { id: "ana", name: "Ana", cards: ["SHIELD"] },
        { id: "ben", name: "Ben", cards: ["SHIELD"] },
        { id: "cy", name: "Cy" },
      ],
      ["ana", "ben"],
    );

    assert.equal(pass(room, "ana", "cy").drinksToPass, 1);
    assert.equal(chain(state, "cy").drinks, 1);
    assert.equal(chain(state, "cy").drinksToPass, 2);

    assert.equal(pass(room, "ben", "cy").drinksToPass, 1);
    assert.equal(state.drinkChains.size, 1);
    assert.equal(chain(state, "cy").drinks, 2);
    assert.equal(chain(state, "cy").drinksToPass, 3);
    assert.equal(drinks(state, "cy"), 2);
    assert.equal(owed(state, "cy"), 2);
    assert.deepEqual(
      events.map((event) => event.message.drinksToPass),
      [1, 1],
    );
  });

  it("escalates one chain 1, then 2, then 3 across deflections", () => {
    const { room, state } = resolution(
      [
        { id: "ana", name: "Ana", cards: ["SHIELD"] },
        { id: "ben", name: "Ben", cards: ["SHIELD"] },
        { id: "cy", name: "Cy", cards: ["SHIELD"] },
        { id: "dee", name: "Dee" },
      ],
      ["ana"],
    );

    assert.equal(chain(state, "ana").drinksToPass, 1);
    assert.equal(pass(room, "ana", "ben").drinksToPass, 1);
    assert.equal(chain(state, "ben").drinks, 1);
    assert.equal(chain(state, "ben").drinksToPass, 2);

    assert.equal(pass(room, "ben", "cy").drinksToPass, 2);
    assert.equal(chain(state, "cy").drinks, 2);
    assert.equal(chain(state, "cy").drinksToPass, 3);

    assert.equal(pass(room, "cy", "dee").drinksToPass, 3);
    assert.equal(chain(state, "dee").drinks, 3);
    assert.equal(chain(state, "dee").drinksToPass, 4);
    assert.equal(drinks(state, "ana"), 0);
    assert.equal(drinks(state, "ben"), 0);
    assert.equal(drinks(state, "cy"), 0);
    assert.equal(drinks(state, "dee"), 3);
  });

  it("CRD-014: two independent shields each pass 1, and the second is not escalated", () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const { room, state, events } = resolution(
        [
          { id: "a", name: "Ada", cards: ["SHIELD"] },
          { id: "b", name: "Bea", cards: ["SHIELD"] },
          { id: "c", name: "Cal" },
          { id: "d", name: "Dee" },
        ],
        ["a", "b"],
      );

      assert.equal(chain(state, "a").drinksToPass, 1);
      assert.equal(chain(state, "b").drinksToPass, 1);
      assert.equal(chain(state, "a").deflections, 0);
      assert.equal(chain(state, "b").deflections, 0);

      const first = pass(room, order[0], order[0] === "a" ? "c" : "d");
      const second = pass(room, order[1], order[1] === "a" ? "c" : "d");

      assert.equal(first.drinksToPass, 1);
      assert.equal(second.drinksToPass, 1);
      assert.equal(drinks(state, "a"), 0);
      assert.equal(drinks(state, "b"), 0);
      assert.equal(drinks(state, "c"), 1);
      assert.equal(drinks(state, "d"), 1);
      assert.equal(owed(state, "c"), 1);
      assert.equal(owed(state, "d"), 1);
      assert.equal(state.drinkChains.has("a"), false);
      assert.equal(state.drinkChains.has("b"), false);
      assert.equal(chain(state, "c").drinks, 1);
      assert.equal(chain(state, "c").drinksToPass, 2);
      assert.equal(chain(state, "d").drinksToPass, 2);
      assert.equal(shields(state, "a"), 0);
      assert.equal(shields(state, "b"), 0);
      assert.deepEqual(
        events.map((event) => event.message.drinksToPass),
        [1, 1],
      );
      assert.equal(events[0].message.drinkCount, events[0].message.drinksToPass);
      assert.equal(events[1].message.cardId, "SHIELD");
    }
  });

  it("escalates one chain 1 → 2 → 3 → 4 with no cap", () => {
    const { room, state, events } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal", cards: ["SHIELD"] },
        { id: "d", name: "Dee", cards: ["SHIELD"] },
        { id: "e", name: "Eve" },
      ],
      ["a"],
    );

    assert.equal(pass(room, "a", "b").drinksToPass, 1);
    assert.equal(drinks(state, "a"), 0);
    assert.equal(chain(state, "b").drinks, 1);
    const shownForBea = chain(state, "b").drinksToPass;
    assert.equal(shownForBea, 2);

    assert.equal(pass(room, "b", "c").drinksToPass, shownForBea);
    assert.equal(drinks(state, "b"), 0);
    assert.equal(drinks(state, "c"), 2);
    assert.equal(owed(state, "c"), 2);
    assert.equal(chain(state, "c").drinksToPass, 3);

    assert.equal(pass(room, "c", "d").drinksToPass, 3);
    assert.equal(drinks(state, "c"), 0);
    assert.equal(drinks(state, "d"), 3);
    assert.equal(chain(state, "d").drinksToPass, 4);

    assert.equal(pass(room, "d", "e").drinksToPass, 4);
    assert.equal(drinks(state, "d"), 0);
    assert.equal(drinks(state, "e"), 4);
    assert.equal(owed(state, "e"), 4);
    assert.equal(chain(state, "e").drinksToPass, 5);
    assert.deepEqual(
      events.map((event) => event.message.drinksToPass),
      [1, 2, 3, 4],
    );
  });

  it("allows a straight-back deflection and escalates again if the original passer shields a second time", () => {
    const stopped = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
      ],
      ["a"],
    );
    pass(stopped.room, "a", "b");
    pass(stopped.room, "b", "a");
    assert.equal(drinks(stopped.state, "b"), 0);
    assert.equal(drinks(stopped.state, "a"), 2);
    assert.equal(owed(stopped.state, "a"), 2);
    assert.equal(chain(stopped.state, "a").drinksToPass, 3);
    assert.equal(shields(stopped.state, "a"), 0);
    assert.equal(stopped.room.applyShield("a", "b"), null);

    const continued = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD", "SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal" },
      ],
      ["a"],
    );
    pass(continued.room, "a", "b");
    pass(continued.room, "b", "a");
    assert.equal(chain(continued.state, "a").drinksToPass, 3);
    assert.equal(pass(continued.room, "a", "c").drinksToPass, 3);
    assert.equal(drinks(continued.state, "a"), 0);
    assert.equal(drinks(continued.state, "c"), 3);
    assert.equal(chain(continued.state, "c").drinksToPass, 4);
    assert.equal(shields(continued.state, "a"), 0);
  });

  it("allows a pass to a 2v2 teammate and uses the same escalation", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
      ["a"],
      "2v2",
    );

    assert.equal(pass(room, "a", "b").drinksToPass, 1);
    assert.equal(drinks(state, "b"), 1);
    assert.equal(chain(state, "b").drinksToPass, 2);
    assert.equal(pass(room, "b", "c").drinksToPass, 2);
    assert.equal(drinks(state, "a"), 0);
    assert.equal(drinks(state, "b"), 0);
    assert.equal(drinks(state, "c"), 2);
  });

  it("rejects a pass to yourself and does not consume the Shield", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD", "TURBO"] },
        { id: "b", name: "Bea" },
      ],
      ["a"],
    );

    assert.equal(room.applyShield("a", "a"), null);
    assert.equal(room.applyShield("a", ""), null);
    assert.equal(room.applyShield("a", "missing"), null);
    assert.equal(shields(state, "a"), 1);
    assert.equal(drinks(state, "a"), 1);
    assert.equal(owed(state, "a"), 1);
    assert.equal(chain(state, "a").drinksToPass, 1);
    assert.deepEqual(state.players.get("a")?.cards.toArray(), ["SHIELD", "TURBO"]);
  });

  it("merges an existing loss and a received pass into one total", () => {
    const { room, state, events } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal", cards: ["SHIELD"] },
        { id: "d", name: "Dee" },
      ],
      ["a", "b"],
    );

    assert.equal(pass(room, "a", "b").drinksToPass, 1);
    assert.equal(state.drinkChains.has("a"), false);
    assert.equal(state.drinkChains.has("b"), true);
    assert.equal([...state.drinkChains.keys()].filter((id) => id === "b").length, 1);
    assert.equal(chain(state, "b").drinks, 2);
    assert.equal(chain(state, "b").deflections, 1);
    assert.equal(chain(state, "b").drinksToPass, 3);
    assert.equal(drinks(state, "b"), 2);
    assert.equal(owed(state, "b"), 2);
    assert.equal(drinks(state, "a"), 0);

    assert.equal(chain(state, "b").drinksToPass, 3);
    assert.equal(pass(room, "b", "c").drinksToPass, 3);
    assert.equal(state.drinkChains.has("b"), false);
    assert.equal(drinks(state, "b"), 0);
    assert.equal(owed(state, "b"), 0);
    assert.equal(drinks(state, "c"), 3);
    assert.equal(owed(state, "c"), 3);
    assert.equal(chain(state, "c").drinks, 3);
    assert.equal(chain(state, "c").drinksToPass, 4);
    assert.equal(events[1].message.drinksToPass, 3);
    assert.equal(events[1].message.drinkCount, 3);

    assert.equal(pass(room, "c", "d").drinksToPass, 4);
    assert.equal(drinks(state, "d"), 4);
    assert.equal(chain(state, "d").drinksToPass, 5);
  });

  it("merges two independent passes onto the same player into one total", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal" },
      ],
      ["a", "b"],
    );

    pass(room, "a", "c");
    assert.equal(chain(state, "b").drinksToPass, 1);
    pass(room, "b", "c");

    assert.equal(state.drinkChains.size, 1);
    assert.equal(chain(state, "c").drinks, 2);
    assert.equal(chain(state, "c").drinksToPass, 3);
    assert.equal(drinks(state, "c"), 2);
    assert.equal(owed(state, "c"), 2);
    assert.equal(drinks(state, "a"), 0);
    assert.equal(drinks(state, "b"), 0);
  });

  it("leaves the merged total on the holder who does not deflect", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea" },
      ],
      ["a", "b"],
    );

    pass(room, "a", "b");
    assert.equal(drinks(state, "b"), 2);
    assert.equal(owed(state, "b"), 2);
    assert.equal(chain(state, "b").drinks, 2);
    assert.equal(chain(state, "b").drinksToPass, 3);
  });

  it("passes an untouched multi-drink loss as-is, then adds 1 on the next deflection", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal" },
      ],
      ["a", "a"],
    );

    assert.equal(state.drinkChains.size, 1);
    assert.equal(chain(state, "a").drinks, 2);
    assert.equal(chain(state, "a").drinksToPass, 2);
    assert.equal(pass(room, "a", "b").drinksToPass, 2);
    assert.equal(chain(state, "b").drinks, 2);
    assert.equal(chain(state, "b").drinksToPass, 3);
    assert.equal(pass(room, "b", "c").drinksToPass, 3);
    assert.equal(drinks(state, "c"), 3);
  });

  it("does not consume a Shield when the player is not holding drinks or the phase is wrong", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
      ],
      ["a"],
    );

    assert.equal(room.applyShield("b", "a"), null);
    assert.equal(shields(state, "b"), 1);

    state.phase = "chart";
    assert.equal(room.applyShield("a", "b"), null);
    assert.equal(shields(state, "a"), 1);
    assert.equal(drinks(state, "a"), 1);
    assert.equal(chain(state, "a").holderId, "a");
  });

  it("keeps drinks from earlier rounds on the counter", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", priorDrinks: 4, cards: ["SHIELD"] },
        { id: "b", name: "Bea", priorDrinks: 2 },
      ],
      ["a"],
    );

    assert.equal(drinks(state, "a"), 5);
    pass(room, "a", "b");
    assert.equal(drinks(state, "a"), 4);
    assert.equal(drinks(state, "b"), 3);
    assert.equal(chain(state, "b").drinks, 1);
  });

  it("starts the next resolution at the new total instead of the previous escalation", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD", "SHIELD"] },
        { id: "b", name: "Bea", cards: ["SHIELD"] },
        { id: "c", name: "Cal" },
      ],
      ["a"],
    );

    pass(room, "a", "b");
    assert.equal(chain(state, "b").drinksToPass, 2);
    room.startWheelPhase();
    assert.equal(state.drinkChains.size, 0);

    state.lastLosers.clear();
    state.lastLosers.push("b");
    state.players.get("b")!.drinks = 1;
    state.players.get("a")!.drinks = 0;
    state.roundCount = 0;
    room.startResolutionPhase();

    assert.equal(chain(state, "b").deflections, 0);
    assert.equal(chain(state, "b").drinks, 1);
    assert.equal(chain(state, "b").drinksToPass, 1);
    assert.equal(pass(room, "b", "c").drinksToPass, 1);
    assert.equal(drinks(state, "c"), 1);
  });

  it("consumes one Shield per successful deflection and leaves a failed second play unused", () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD", "SHIELD"] },
        { id: "b", name: "Bea" },
      ],
      ["a"],
    );

    pass(room, "a", "b");
    assert.equal(shields(state, "a"), 1);
    assert.equal(room.applyShield("a", "b"), null);
    assert.equal(shields(state, "a"), 1);
    assert.equal(drinks(state, "b"), 1);
  });

  it("clears a holder's drink chain when their seat is removed", async () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal", cards: ["SHIELD"] },
        { id: "d", name: "Dee" },
      ],
      ["a", "c"],
    );

    pass(room, "a", "b");
    assert.equal(chain(state, "b").drinks, 1);
    assert.equal(chain(state, "b").deflections, 1);
    assert.equal(chain(state, "b").drinksToPass, 2);

    await room.onLeave(client("b"), CloseCode.CONSENTED);

    assert.equal(state.players.has("b"), false);
    assert.equal(state.drinkChains.has("b"), false);
    assert.equal(owed(state, "b"), 0);
    assert.equal(chain(state, "c").drinks, 1);
    assert.equal(chain(state, "c").deflections, 0);
    assert.equal(chain(state, "c").drinksToPass, 1);

    assert.equal(pass(room, "c", "d").drinksToPass, 1);
    assert.equal(state.drinkChains.has("b"), false);
    assert.equal(owed(state, "b"), 0);
    assert.equal(chain(state, "d").drinks, 1);
    assert.equal(chain(state, "d").deflections, 1);
    assert.equal(chain(state, "d").drinksToPass, 2);
    assert.equal(drinks(state, "d"), 1);
  });

  it("keeps a holder's drink chain while reconnect grace still holds the seat", async () => {
    const { room, state } = resolution(
      [
        { id: "a", name: "Ada", cards: ["SHIELD"] },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
      ["a"],
    );

    pass(room, "a", "b");
    assert.equal(chain(state, "b").drinks, 1);
    assert.equal(chain(state, "b").drinksToPass, 2);

    let rejectGrace: (error: Error) => void = () => {};
    const grace = new Promise<unknown>((_resolve, reject) => {
      rejectGrace = reject;
    });
    room.allowReconnection = (() => grace) as unknown as LobbyRoom["allowReconnection"];

    const leaving = room.onLeave(client("b"), CloseCode.ABNORMAL_CLOSURE);

    assert.equal(state.players.has("b"), true);
    assert.equal(state.players.get("b")?.isConnected, false);
    assert.equal(state.drinkChains.has("b"), true);
    assert.equal(chain(state, "b").drinks, 1);
    assert.equal(chain(state, "b").deflections, 1);
    assert.equal(chain(state, "b").drinksToPass, 2);
    assert.equal(owed(state, "b"), 1);

    rejectGrace(new Error("grace expired"));
    await leaving;

    assert.equal(state.players.has("b"), false);
    assert.equal(state.drinkChains.has("b"), false);
    assert.equal(owed(state, "b"), 0);
  });

  it("CRD-017 holds resolution for a disconnected seated Shield target until the decision timer or an act", () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const waiting = resolution(
        [
          { id: "a", name: "Ada", cards: ["SHIELD"] },
          { id: "b", name: "Bea", cards: ["SHIELD"] },
          { id: "c", name: "Cal" },
        ],
        ["a"],
      );
      pass(waiting.room, "a", "b");
      const waitingSeat = waiting.state.selectedPlayers.indexOf("b");
      if (waitingSeat !== -1) waiting.state.selectedPlayers.splice(waitingSeat, 1);
      waiting.room.clients.push(client("a"));
      const target = waiting.state.players.get("b")!;
      target.isConnected = false;
      waiting.state.players.get("a")!.isReady = true;
      waiting.state.players.get("c")!.isReady = true;

      waiting.room.checkAllReady();
      assert.equal(waiting.state.phase, "resolution");
      assert.ok(SHIELD_DECISION_MS < 120_000);

      now += SHIELD_DECISION_MS - 1;
      waiting.room.checkAllReady();
      assert.equal(waiting.state.phase, "resolution");

      now += 1;
      waiting.room.checkAllReady();
      assert.equal(waiting.state.phase, "chart");

      now = realNow();
      const early = resolution(
        [
          { id: "a", name: "Ada", cards: ["SHIELD"] },
          { id: "b", name: "Bea", cards: ["SHIELD"] },
          { id: "c", name: "Cal" },
        ],
        ["a"],
      );
      pass(early.room, "a", "b");
      const earlySeat = early.state.selectedPlayers.indexOf("b");
      if (earlySeat !== -1) early.state.selectedPlayers.splice(earlySeat, 1);
      early.room.clients.push(client("c"));
      const bea = early.state.players.get("b")!;
      bea.isConnected = false;
      early.state.players.get("a")!.isReady = true;
      early.state.players.get("c")!.isReady = true;

      early.room.checkAllReady();
      assert.equal(early.state.phase, "resolution");

      bea.isConnected = true;
      early.room.checkAllReady();
      assert.equal(early.state.phase, "resolution");

      bea.isReady = true;
      early.room.checkAllReady();
      assert.equal(early.state.phase, "chart");
    } finally {
      Date.now = realNow;
    }
  });
});
