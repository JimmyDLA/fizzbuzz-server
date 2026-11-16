import type { Client } from "@colyseus/core";
import assert from "node:assert/strict";
import { GameResult, IMiniGame } from "../src/games/IMiniGame";
import { LobbyState, Player } from "../src/rooms/schema/LobbyState";
import { LobbyRoom } from "../src/rooms/LobbyRoom";
import { scoreGameResult } from "../src/rooms/scoring";

export interface TestPlayer {
  id: string;
  name: string;
  gameScore?: number;
  connected?: boolean;
  effects?: string;
  score?: number;
  drinks?: number;
}

export interface ExpectedOutcome {
  scores: Record<string, { score: number; drinks: number }>;
  winners: string[];
  losers: string[];
  tiedIds: string[];
  result?: unknown;
  gameScores?: Record<string, number>;
  /** onEnd left a previous resolution in place and reported an empty result. */
  preservesPriorResolution?: boolean;
}

export function client(id: string): Client {
  return { sessionId: id, send() { /* word_feedback and similar acks */ } } as unknown as Client;
}

export function makeState(options: {
  type: string;
  category?: string;
  players: TestPlayer[];
}): LobbyState {
  const state = new LobbyState();
  state.phase = "playing";
  state.currentGameType = options.type;
  state.currentCategory = options.category ?? "";
  for (const spec of options.players) {
    const player = new Player();
    player.id = spec.id;
    player.name = spec.name;
    player.score = spec.score ?? 0;
    player.drinks = spec.drinks ?? 0;
    player.gameScore = spec.gameScore ?? 0;
    player.isConnected = spec.connected !== false;
    player.activeEffects = spec.effects ?? "";
    player.gameData = "{}";
    state.players.set(spec.id, player);
    state.selectedPlayers.push(spec.id);
  }
  return state;
}

export function player(state: LobbyState, id: string): Player {
  const found = state.players.get(id);
  if (!found) throw new Error(`missing player ${id}`);
  return found;
}

function snapshotScores(state: LobbyState): Record<string, { score: number; drinks: number }> {
  const actual: Record<string, { score: number; drinks: number }> = {};
  state.players.forEach((entry, id) => {
    actual[id] = { score: entry.score, drinks: entry.drinks };
  });
  return actual;
}

/**
 * End a mini-game the way LobbyRoom does: onEnd reports a result and does not
 * touch score or drinks, then scoreGameResult applies the no-action rule and
 * the shared +3 / +1 drink payout.
 */
export function settle(game: IMiniGame, state: LobbyState): GameResult {
  const before = snapshotScores(state);
  const result = game.onEnd(state);
  assert.deepEqual(snapshotScores(state), before, "onEnd must not change score or drinks");
  return scoreGameResult(state, result);
}

export function assertOutcome(state: LobbyState, expected: ExpectedOutcome): void {
  const actual: Record<string, { score: number; drinks: number }> = {};
  state.players.forEach((entry, id) => {
    actual[id] = { score: entry.score, drinks: entry.drinks };
  });
  assert.deepEqual(actual, expected.scores, "lobby score and drinks");
  assert.deepEqual(state.lastWinners.toArray(), expected.winners, "lastWinners");
  assert.deepEqual(state.lastLosers.toArray(), expected.losers, "lastLosers");
  if (expected.gameScores) {
    const gameScores: Record<string, number> = {};
    state.players.forEach((entry, id) => {
      gameScores[id] = entry.gameScore;
    });
    assert.deepEqual(gameScores, expected.gameScores, "gameScore");
  }
  if (expected.result !== undefined) {
    assert.deepEqual(JSON.parse(state.lastGameResult), expected.result, "lastGameResult");
  }
}

export function finish(game: IMiniGame, state: LobbyState, expected: ExpectedOutcome): void {
  const result = settle(game, state);
  assertOutcome(state, expected);
  assert.deepEqual(result.tiedIds, expected.tiedIds, "tiedIds");
  if (expected.preservesPriorResolution) {
    assert.deepEqual(result, { winners: [], losers: [], tiedIds: [] });
  } else {
    assert.deepEqual(result.winners, state.lastWinners.toArray(), "result.winners");
    assert.deepEqual(result.losers, state.lastLosers.toArray(), "result.losers");
  }
}

/** Resolution phase: Double Points extra +3, then effects are cleared. */
export function resolveRound(state: LobbyState): void {
  const room = new LobbyRoom();
  room.setState(state);
  room.startResolutionPhase();
}

export function repeat(times: number, fn: () => void): void {
  for (let i = 0; i < times; i++) fn();
}

export function withClock<T>(fn: (advance: (ms: number) => void) => T): T {
  let now = 5_000_000;
  const realNow = Date.now;
  const realSetTimeout = global.setTimeout;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  Date.now = () => now;
  global.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = realSetTimeout(callback as (...cbArgs: unknown[]) => void, delay, ...args);
    timers.push(id);
    return id;
  }) as unknown as typeof setTimeout;
  try {
    return fn((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
    global.setTimeout = realSetTimeout;
    for (const id of timers) clearTimeout(id);
  }
}
