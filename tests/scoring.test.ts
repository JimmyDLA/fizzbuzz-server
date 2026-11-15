import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BalloonInflate } from "../src/games/BalloonInflate";
import { Cyclone } from "../src/games/Cyclone";
import { HotPotato } from "../src/games/HotPotato";
import { LumberCut } from "../src/games/LumberCut";
import { MathProblem } from "../src/games/MathProblem";
import { Perfection } from "../src/games/Perfection";
import { RockPaperScissors } from "../src/games/RockPaperScissors";
import { Scrabble } from "../src/games/Scrabble";
import { ScreenPainting } from "../src/games/ScreenPainting";
import { SimonSays } from "../src/games/SimonSays";
import { TappingRace } from "../src/games/TappingRace";
import { Trivia } from "../src/games/Trivia";
import { LobbyState } from "../src/rooms/schema/LobbyState";
import {
  assertOutcome,
  client,
  finish,
  makeState,
  player,
  repeat,
  resolveRound,
  settle,
  withClock,
} from "./helpers";

/**
 * Characterization of who wins, who drinks, and the resolution payloads.
 * These quirks are intentional: do not "fix" them.
 * - Non-RPS ties: every tied player wins, and a 2v2 tie is both teams win.
 * - A score of 0 is not a win (except Lumber Cut, where cutting nothing ties and everyone wins).
 * - RPS final tie or 0-0: both players lose. Battle Royale still scores only the first two ids.
 * - Hot Potato Battle Royale: everyone except the holder gets +3.
 * - Screen Painting timeout: the earliest selected player at the top coverage wins alone.
 */

const score = (points: number, drinks = 0) => ({ score: points, drinks });

function board(
  title: string,
  rows: Array<{ playerId: string; playerName: string; scoreValue?: number; scoreLabel: string; isWinner: boolean }>,
) {
  return {
    type: "leaderboard",
    title,
    leaderboard: rows.map((row) => {
      const entry: Record<string, unknown> = {
        playerId: row.playerId,
        playerName: row.playerName,
        scoreLabel: row.scoreLabel,
        isWinner: row.isWinner,
      };
      if (row.scoreValue !== undefined) entry.scoreValue = row.scoreValue;
      return entry;
    }),
  };
}

function setSharedGameData(state: LobbyState, data: unknown): void {
  const json = JSON.stringify(data);
  state.selectedPlayers.forEach((id) => {
    player(state, id).gameData = json;
  });
}

describe("Tapping Race", () => {
  it("SCO-004 Battle Royale: first place +3, everyone else drinks", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 9 },
        { id: "b", name: "Bea", gameScore: 4 },
        { id: "c", name: "Cal", gameScore: 4 },
      ],
    });
    finish(new TappingRace(), state, {
      scores: { a: score(3), b: score(0, 1), c: score(0, 1) },
      winners: ["a"],
      losers: ["b", "c"],
      result: board("Final Tap Counts", [
        { playerId: "a", playerName: "Ada", scoreValue: 9, scoreLabel: "9 Taps", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 4, scoreLabel: "4 Taps", isWinner: false },
        { playerId: "c", playerName: "Cal", scoreValue: 4, scoreLabel: "4 Taps", isWinner: false },
      ]),
    });
  });

  it("SCO-003 / SCO-007 tie: every player on the top score wins", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 4 },
        { id: "b", name: "Bea", gameScore: 4 },
      ],
    });
    finish(new TappingRace(), state, {
      scores: { a: score(3), b: score(3) },
      winners: ["a", "b"],
      losers: [],
      result: board("Final Tap Counts", [
        { playerId: "a", playerName: "Ada", scoreValue: 4, scoreLabel: "4 Taps", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 4, scoreLabel: "4 Taps", isWinner: true },
      ]),
    });
  });

  it("gives no points when nobody tapped", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 0 },
        { id: "b", name: "Bea", gameScore: 0 },
      ],
    });
    finish(new TappingRace(), state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("2v2: the higher team wins and a tied score makes both teams win", () => {
    const ahead = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 5 },
        { id: "b", name: "Bea", gameScore: 1 },
        { id: "c", name: "Cal", gameScore: 3 },
        { id: "d", name: "Dee", gameScore: 2 },
      ],
    });
    finish(new TappingRace(), ahead, {
      scores: { a: score(3), b: score(3), c: score(0, 1), d: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c", "d"],
      result: board("Final Tap Counts", [
        { playerId: "a", playerName: "Ada", scoreValue: 6, scoreLabel: "6 Team Taps (5 Individually)", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 6, scoreLabel: "6 Team Taps (1 Individually)", isWinner: true },
        { playerId: "c", playerName: "Cal", scoreValue: 5, scoreLabel: "5 Team Taps (3 Individually)", isWinner: false },
        { playerId: "d", playerName: "Dee", scoreValue: 5, scoreLabel: "5 Team Taps (2 Individually)", isWinner: false },
      ]),
    });

    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 3 },
        { id: "c", name: "Cal", gameScore: 4 },
        { id: "d", name: "Dee", gameScore: 1 },
      ],
    });
    finish(new TappingRace(), tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
    });

    const zeros = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    finish(new TappingRace(), zeros, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(0, 1), d: score(0, 1) },
      winners: [],
      losers: ["a", "b", "c", "d"],
    });
  });

  it("falls back to individual scoring when 2v2 does not have 4 players", () => {
    const state = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 1 },
        { id: "b", name: "Bea", gameScore: 5 },
        { id: "c", name: "Cal", gameScore: 5 },
      ],
    });
    finish(new TappingRace(), state, {
      scores: { a: score(0, 1), b: score(3), c: score(3) },
      winners: ["b", "c"],
      losers: ["a"],
    });
  });

  it("ignores disconnected players", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 1 },
        { id: "c", name: "Cal", gameScore: 99, connected: false },
      ],
    });
    finish(new TappingRace(), state, {
      scores: { a: score(3), b: score(0, 1), c: score(0) },
      winners: ["a"],
      losers: ["b"],
    });
  });

  it("turbo counts 1.5 per tap toward who wins, and the lobby payout stays +3", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new TappingRace();
    game.onInit(state);
    repeat(2, () => game.onMessage(client("a"), { action: "tap" }, state));
    repeat(2, () => game.onMessage(client("b"), { action: "tap" }, state));
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      gameScores: { a: 3, b: 2 },
      result: board("Final Tap Counts", [
        { playerId: "a", playerName: "Ada", scoreValue: 3, scoreLabel: "3 Taps", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 2, scoreLabel: "2 Taps", isWinner: false },
      ]),
    });
  });
});

describe("Math Problem", () => {
  it("awards the high score and shares a tie", () => {
    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 3 },
        { id: "b", name: "Bea", gameScore: 1 },
      ],
    });
    finish(new MathProblem(), ahead, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: {
        type: "timeline",
        title: "Math Breakdown",
        timeline: [
          { playerId: "a", playerName: "Ada", scoreValue: 3, scoreLabel: "3 Points", isWinner: true, events: [] },
          { playerId: "b", playerName: "Bea", scoreValue: 1, scoreLabel: "1 Points", isWinner: false, events: [] },
        ],
      },
    });

    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 2 },
        { id: "c", name: "Cal", gameScore: 1 },
      ],
    });
    finish(new MathProblem(), tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });
  });

  it("gives no points when every score is 0", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    finish(new MathProblem(), state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("2v2 ties make both teams win, and a 0-0 makes everyone drink", () => {
    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 1 },
        { id: "c", name: "Cal", gameScore: 3 },
        { id: "d", name: "Dee", gameScore: 0 },
      ],
    });
    finish(new MathProblem(), tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
    });

    const zeros = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    finish(new MathProblem(), zeros, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(0, 1), d: score(0, 1) },
      winners: [],
      losers: ["a", "b", "c", "d"],
    });
  });

  it("turbo adds +1 gameScore at the end before deciding the winner", () => {
    const flipped = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 2, effects: JSON.stringify({ turbo: true }) },
      ],
    });
    finish(new MathProblem(), flipped, {
      scores: { a: score(0, 1), b: score(3) },
      winners: ["b"],
      losers: ["a"],
      gameScores: { a: 2, b: 3 },
      result: {
        type: "timeline",
        title: "Math Breakdown",
        timeline: [
          { playerId: "b", playerName: "Bea", scoreValue: 3, scoreLabel: "3 Points", isWinner: true, events: [] },
          { playerId: "a", playerName: "Ada", scoreValue: 2, scoreLabel: "2 Points", isWinner: false, events: [] },
        ],
      },
    });

    const stillTied = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 2, effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea", gameScore: 2, effects: JSON.stringify({ turbo: true }) },
      ],
    });
    finish(new MathProblem(), stillTied, {
      scores: { a: score(3), b: score(3) },
      winners: ["a", "b"],
      losers: [],
      gameScores: { a: 3, b: 3 },
    });
  });
});

describe("Trivia", () => {
  it("shares a positive tie and drinks on a zero board", () => {
    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 4 },
        { id: "b", name: "Bea", gameScore: 4 },
      ],
    });
    finish(new Trivia(), tied, {
      scores: { a: score(3), b: score(3) },
      winners: ["a", "b"],
      losers: [],
      result: {
        type: "timeline",
        title: "Trivia Breakdown",
        timeline: [
          { playerId: "a", playerName: "Ada", scoreValue: 4, scoreLabel: "4 Points", isWinner: true, events: [] },
          { playerId: "b", playerName: "Bea", scoreValue: 4, scoreLabel: "4 Points", isWinner: true, events: [] },
        ],
      },
    });

    const zeros = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    finish(new Trivia(), zeros, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("2v2 tie is both teams, and a higher team takes it alone", () => {
    const ahead = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 1 },
        { id: "b", name: "Bea", gameScore: 1 },
        { id: "c", name: "Cal", gameScore: 4 },
        { id: "d", name: "Dee", gameScore: 0 },
      ],
    });
    finish(new Trivia(), ahead, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(3), d: score(3) },
      winners: ["c", "d"],
      losers: ["a", "b"],
    });

    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 2 },
        { id: "c", name: "Cal", gameScore: 3 },
        { id: "d", name: "Dee", gameScore: 1 },
      ],
    });
    finish(new Trivia(), tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
    });
  });

  it("turbo adds +1 gameScore at the end", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 1, effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea", gameScore: 1 },
      ],
    });
    finish(new Trivia(), state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      gameScores: { a: 2, b: 1 },
    });
  });
});

describe("Hot Potato", () => {
  function hold(state: LobbyState, holderId: string): void {
    setSharedGameData(state, { potatoHolderId: holderId, passCount: 3 });
  }

  it("MIN-004 the holder drinks and the other player scores", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    new HotPotato().onInit(state);
    hold(state, "b");
    finish(new HotPotato(), state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: {
        type: "elimination",
        title: "Potato Explosion",
        leaderboard: [
          { playerId: "a", playerName: "Ada", scoreLabel: "Survived", isWinner: true },
          { playerId: "b", playerName: "Bea", scoreLabel: "Blew Up", isWinner: false },
        ],
      },
    });
  });

  it("Battle Royale gives +3 to everyone except the holder", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
    });
    new HotPotato().onInit(state);
    hold(state, "b");
    finish(new HotPotato(), state, {
      scores: { a: score(3), b: score(0, 1), c: score(3) },
      winners: ["a", "c"],
      losers: ["b"],
      result: {
        type: "elimination",
        title: "Potato Explosion",
        leaderboard: [
          { playerId: "a", playerName: "Ada", scoreLabel: "Survived", isWinner: true },
          { playerId: "c", playerName: "Cal", scoreLabel: "Survived", isWinner: true },
          { playerId: "b", playerName: "Bea", scoreLabel: "Blew Up", isWinner: false },
        ],
      },
    });
  });

  it("2v2 drinks the holder's whole team", () => {
    const state = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    new HotPotato().onInit(state);
    hold(state, "c");
    finish(new HotPotato(), state, {
      scores: { a: score(3), b: score(3), c: score(0, 1), d: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c", "d"],
    });
  });
});

describe("Lumber Cut", () => {
  it("MIN-013 nobody cut: everyone still wins", () => {
    for (const type of ["1v1", "BR", "2v2"] as const) {
      const players = type === "2v2"
        ? [
            { id: "a", name: "Ada" },
            { id: "b", name: "Bea" },
            { id: "c", name: "Cal" },
            { id: "d", name: "Dee" },
          ]
        : [
            { id: "a", name: "Ada" },
            { id: "b", name: "Bea" },
            ...(type === "BR" ? [{ id: "c", name: "Cal" }] : []),
          ];
      const state = makeState({ type, players });
      const game = new LumberCut();
      game.onInit(state);
      const ids = players.map((entry) => entry.id);
      finish(game, state, {
        scores: Object.fromEntries(ids.map((id) => [id, score(3)])),
        winners: ids,
        losers: [],
        ...(type === "1v1"
          ? {
              result: board("Lumber Cut Results", [
                { playerId: "a", playerName: "Ada", scoreValue: 0, scoreLabel: "0% Cut", isWinner: true },
                { playerId: "b", playerName: "Bea", scoreValue: 0, scoreLabel: "0% Cut", isWinner: true },
              ]),
            }
          : {}),
      });
    }
  });

  it("highest cut wins, and an equal cut is shared", () => {
    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const aheadGame = new LumberCut();
    aheadGame.onInit(ahead);
    const aheadData = JSON.parse(player(ahead, "a").gameData);
    aheadData.teams[0].pairs = 4;
    aheadData.teams[1].pairs = 1;
    player(ahead, "a").gameData = JSON.stringify(aheadData);
    finish(aheadGame, ahead, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: board("Lumber Cut Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 20, scoreLabel: "20% Cut", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 5, scoreLabel: "5% Cut", isWinner: false },
      ]),
    });

    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
    });
    const tiedGame = new LumberCut();
    tiedGame.onInit(tied);
    const tiedData = JSON.parse(player(tied, "a").gameData);
    tiedData.teams[0].pairs = 3;
    tiedData.teams[1].pairs = 3;
    tiedData.teams[2].pairs = 1;
    player(tied, "a").gameData = JSON.stringify(tiedData);
    finish(tiedGame, tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });
  });

  it("turbo adds 1.5 pairs for the player who finishes the cut", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new LumberCut();
    game.onInit(state);
    for (const id of ["a", "b"]) {
      game.onMessage(client(id), { action: "pull", side: "left" }, state);
      game.onMessage(client(id), { action: "pull", side: "right" }, state);
    }
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
    });
    const data = JSON.parse(player(state, "a").gameData);
    assert.equal(data.teams[0].pairs, 1.5);
    assert.equal(data.teams[1].pairs, 1);
  });

  it("does nothing when nobody is connected", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", score: 9, connected: false },
        { id: "b", name: "Bea", score: 4, drinks: 2, connected: false },
      ],
    });
    state.lastWinners.push("stale");
    state.lastGameResult = "keep";
    finish(new LumberCut(), state, {
      scores: { a: score(9), b: { score: 4, drinks: 2 } },
      winners: ["stale"],
      losers: [],
    });
    assert.equal(state.lastGameResult, "keep");
  });
});

describe("Rock Paper Scissors", () => {
  function playRound(game: RockPaperScissors, state: LobbyState, first: string, second: string, advance: (ms: number) => void) {
    game.onMessage(client("a"), { action: "pick", choice: first }, state);
    game.onMessage(client("b"), { action: "pick", choice: second }, state);
    advance(3200);
    game.onTick(state);
    advance(2001);
    game.onTick(state);
    advance(2001);
    game.onTick(state);
  }

  it("first to two round wins gets +3 and the other drinks", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new RockPaperScissors();
    game.onInit(state);
    withClock((advance) => {
      playRound(game, state, "rock", "scissors", advance);
      playRound(game, state, "rock", "scissors", advance);
      finish(game, state, {
        scores: { a: score(3), b: score(0, 1) },
        winners: ["a"],
        losers: ["b"],
        result: {
          type: "elimination",
          title: "RPS Results",
          leaderboard: [
            { playerId: "a", playerName: "Ada", scoreLabel: "Winner! (2 Wins)", isWinner: true },
            { playerId: "b", playerName: "Bea", scoreLabel: "Defeated (0 Wins)", isWinner: false },
          ],
        },
      });
    });
  });

  it("a 1-1 final tie and a 0-0 both make the two players lose", () => {
    const tied = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const tiedGame = new RockPaperScissors();
    tiedGame.onInit(tied);
    withClock((advance) => {
      playRound(tiedGame, tied, "rock", "scissors", advance);
      playRound(tiedGame, tied, "rock", "paper", advance);
      finish(tiedGame, tied, {
        scores: { a: score(0, 1), b: score(0, 1) },
        winners: [],
        losers: ["a", "b"],
        result: {
          type: "elimination",
          title: "RPS Results",
          leaderboard: [
            { playerId: "a", playerName: "Ada", scoreLabel: "Defeated (1 Wins)", isWinner: false },
            { playerId: "b", playerName: "Bea", scoreLabel: "Defeated (1 Wins)", isWinner: false },
          ],
        },
      });
    });

    const none = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const noneGame = new RockPaperScissors();
    noneGame.onInit(none);
    finish(noneGame, none, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
      result: {
        type: "elimination",
        title: "RPS Results",
        leaderboard: [
          { playerId: "a", playerName: "Ada", scoreLabel: "Defeated (0 Wins)", isWinner: false },
          { playerId: "b", playerName: "Bea", scoreLabel: "Defeated (0 Wins)", isWinner: false },
        ],
      },
    });
  });

  it("MIN-016 Battle Royale only scores the first two selected players", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal", score: 11, drinks: 4 },
      ],
    });
    const game = new RockPaperScissors();
    game.onInit(state);
    withClock((advance) => {
      playRound(game, state, "paper", "rock", advance);
      playRound(game, state, "paper", "rock", advance);
      finish(game, state, {
        scores: { a: score(3), b: score(0, 1), c: { score: 11, drinks: 4 } },
        winners: ["a"],
        losers: ["b"],
        result: {
          type: "elimination",
          title: "RPS Results",
          leaderboard: [
            { playerId: "a", playerName: "Ada", scoreLabel: "Winner! (2 Wins)", isWinner: true },
            { playerId: "b", playerName: "Bea", scoreLabel: "Defeated (0 Wins)", isWinner: false },
            { playerId: "c", playerName: "Cal", scoreLabel: "Tied (0 Wins)", isWinner: false },
          ],
        },
      });
    });
  });

  it("does nothing when fewer than two players are connected", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", score: 8 },
        { id: "b", name: "Bea", connected: false, score: 2, drinks: 1 },
      ],
    });
    state.lastWinners.push("stale");
    state.lastGameResult = "keep";
    const game = new RockPaperScissors();
    game.onInit(state);
    finish(game, state, {
      scores: { a: score(8), b: { score: 2, drinks: 1 } },
      winners: ["stale"],
      losers: [],
    });
    assert.equal(state.lastGameResult, "keep");
  });
});

describe("Cyclone", () => {
  function stop(game: Cyclone, state: LobbyState, id: string, index: number): void {
    game.onMessage(client(id), { action: "stop", index }, state);
  }

  it("closest light wins, and an equal distance is shared", () => {
    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const aheadGame = new Cyclone();
    aheadGame.onInit(ahead);
    stop(aheadGame, ahead, "a", 0);
    stop(aheadGame, ahead, "b", 5);
    finish(aheadGame, ahead, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: board("Cyclone Precision", [
        { playerId: "a", playerName: "Ada", scoreValue: 0, scoreLabel: "BULLSEYE!", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: -5, scoreLabel: "Missed by 5", isWinner: false },
      ]),
    });

    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
    });
    const tiedGame = new Cyclone();
    tiedGame.onInit(tied);
    stop(tiedGame, tied, "a", 2);
    stop(tiedGame, tied, "b", 48);
    stop(tiedGame, tied, "c", 10);
    finish(tiedGame, tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });
  });

  it("everyone drinks when nobody stops", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new Cyclone();
    game.onInit(state);
    finish(game, state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
      result: board("Cyclone Precision", [
        { playerId: "a", playerName: "Ada", scoreValue: -999, scoreLabel: "Timeout", isWinner: false },
        { playerId: "b", playerName: "Bea", scoreValue: -999, scoreLabel: "Timeout", isWinner: false },
      ]),
    });
  });

  it("2v2 uses the lower combined miss, and an equal total is both teams", () => {
    const ahead = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const aheadGame = new Cyclone();
    aheadGame.onInit(ahead);
    stop(aheadGame, ahead, "a", 0);
    stop(aheadGame, ahead, "b", 1);
    stop(aheadGame, ahead, "c", 5);
    stop(aheadGame, ahead, "d", 5);
    finish(aheadGame, ahead, {
      scores: { a: score(3), b: score(3), c: score(0, 1), d: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c", "d"],
    });

    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const tiedGame = new Cyclone();
    tiedGame.onInit(tied);
    for (const id of ["a", "b", "c", "d"]) stop(tiedGame, tied, id, 3);
    finish(tiedGame, tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
    });

    const timeout = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const timeoutGame = new Cyclone();
    timeoutGame.onInit(timeout);
    finish(timeoutGame, timeout, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(0, 1), d: score(0, 1) },
      winners: [],
      losers: ["a", "b", "c", "d"],
    });
  });
});

describe("Balloon Inflate", () => {
  function pumps(game: BalloonInflate, state: LobbyState, id: string, times: number): void {
    repeat(times, () => game.onMessage(client(id), { action: "pump" }, state));
  }

  it("timeout: the biggest balloon wins and a tie is shared", () => {
    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const aheadGame = new BalloonInflate();
    aheadGame.onInit(ahead);
    pumps(aheadGame, ahead, "a", 3);
    pumps(aheadGame, ahead, "b", 1);
    finish(aheadGame, ahead, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: board("Balloon Sizes", [
        { playerId: "a", playerName: "Ada", scoreValue: 12, scoreLabel: "12%", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 4, scoreLabel: "4%", isWinner: false },
      ]),
    });

    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
    });
    const tiedGame = new BalloonInflate();
    tiedGame.onInit(tied);
    pumps(tiedGame, tied, "a", 2);
    pumps(tiedGame, tied, "b", 2);
    pumps(tiedGame, tied, "c", 1);
    finish(tiedGame, tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });
  });

  it("nobody pumped: everyone drinks", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new BalloonInflate();
    game.onInit(state);
    finish(game, state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("the player who pops wins immediately", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
      ],
    });
    const game = new BalloonInflate();
    game.onInit(state);
    pumps(game, state, "b", 2);
    pumps(game, state, "a", 25);
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1), c: score(0, 1) },
      winners: ["a"],
      losers: ["b", "c"],
      result: board("Balloon Sizes", [
        { playerId: "a", playerName: "Ada", scoreValue: 100, scoreLabel: "POPPED", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 8, scoreLabel: "8%", isWinner: false },
        { playerId: "c", playerName: "Cal", scoreValue: 0, scoreLabel: "0%", isWinner: false },
      ]),
    });
  });

  it("turbo pumps 6 instead of 4 and still pays a flat +3", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new BalloonInflate();
    game.onInit(state);
    pumps(game, state, "a", 1);
    pumps(game, state, "b", 1);
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: board("Balloon Sizes", [
        { playerId: "a", playerName: "Ada", scoreValue: 6, scoreLabel: "6%", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 4, scoreLabel: "4%", isWinner: false },
      ]),
    });
  });

  it("2v2 timeout tie is both teams, a pop is that team, and 0-0 is everyone drinks", () => {
    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const tiedGame = new BalloonInflate();
    tiedGame.onInit(tied);
    pumps(tiedGame, tied, "a", 2);
    pumps(tiedGame, tied, "b", 1);
    pumps(tiedGame, tied, "c", 3);
    finish(tiedGame, tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
    });

    const popped = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const poppedGame = new BalloonInflate();
    poppedGame.onInit(popped);
    pumps(poppedGame, popped, "c", 25);
    finish(poppedGame, popped, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(3), d: score(3) },
      winners: ["c", "d"],
      losers: ["a", "b"],
      result: board("Balloon Sizes", [
        { playerId: "c", playerName: "Cal", scoreValue: 100, scoreLabel: "POPPED", isWinner: true },
        { playerId: "d", playerName: "Dee", scoreValue: 100, scoreLabel: "POPPED", isWinner: true },
        { playerId: "a", playerName: "Ada", scoreValue: 0, scoreLabel: "0% Team Total (0% ind.)", isWinner: false },
        { playerId: "b", playerName: "Bea", scoreValue: 0, scoreLabel: "0% Team Total (0% ind.)", isWinner: false },
      ]),
    });

    const empty = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    const emptyGame = new BalloonInflate();
    emptyGame.onInit(empty);
    finish(emptyGame, empty, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(0, 1), d: score(0, 1) },
      winners: [],
      losers: ["a", "b", "c", "d"],
    });
  });
});

describe("Simon Says", () => {
  function script(state: LobbyState, winners: string[], activePlayers: string[]): void {
    player(state, state.selectedPlayers[0]).gameData = JSON.stringify({ winners, activePlayers });
  }

  it("MIN-014 players who fail on the same round share the win", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 3 },
        { id: "b", name: "Bea", gameScore: 3 },
        { id: "c", name: "Cal", gameScore: 2 },
      ],
    });
    script(state, ["a", "b"], []);
    finish(new SimonSays(), state, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
      result: board("Simon Says Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 3, scoreLabel: "Survived 3 Rounds", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 3, scoreLabel: "Survived 3 Rounds", isWinner: true },
        { playerId: "c", playerName: "Cal", scoreValue: 2, scoreLabel: "Survived 2 Rounds", isWinner: false },
      ]),
    });
  });

  it("a sole survivor wins and a round-1 wipeout drinks everyone", () => {
    const sole = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 4 },
        { id: "b", name: "Bea", gameScore: 3 },
      ],
    });
    script(sole, ["a"], []);
    finish(new SimonSays(), sole, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
    });

    const wipeout = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    script(wipeout, [], []);
    finish(new SimonSays(), wipeout, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("uses the remaining active players when winners were never set", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 2 },
        { id: "b", name: "Bea", gameScore: 2 },
        { id: "c", name: "Cal", gameScore: 1 },
      ],
    });
    script(state, [], ["a", "b"]);
    finish(new SimonSays(), state, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });
  });
});

describe("Scrabble", () => {
  it("high score wins, a tie is shared, and a blank board drinks", () => {
    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 8 },
        { id: "b", name: "Bea", gameScore: 3 },
      ],
    });
    finish(new Scrabble(), ahead, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      result: board("Scrabble Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 8, scoreLabel: "8 Points", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 3, scoreLabel: "3 Points", isWinner: false },
      ]),
    });

    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 5 },
        { id: "b", name: "Bea", gameScore: 5 },
        { id: "c", name: "Cal", gameScore: 2 },
      ],
    });
    finish(new Scrabble(), tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
    });

    const blank = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    finish(new Scrabble(), blank, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("2v2 tie with points is both teams, and 0-0 is everyone drinks", () => {
    const tied = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada", gameScore: 4 },
        { id: "b", name: "Bea", gameScore: 1 },
        { id: "c", name: "Cal", gameScore: 3 },
        { id: "d", name: "Dee", gameScore: 2 },
      ],
    });
    finish(new Scrabble(), tied, {
      scores: { a: score(3), b: score(3), c: score(3), d: score(3) },
      winners: ["a", "b", "c", "d"],
      losers: [],
      result: board("Scrabble Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 4, scoreLabel: "4 Points (Team: 5)", isWinner: true },
        { playerId: "c", playerName: "Cal", scoreValue: 3, scoreLabel: "3 Points (Team: 5)", isWinner: true },
        { playerId: "d", playerName: "Dee", scoreValue: 2, scoreLabel: "2 Points (Team: 5)", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 1, scoreLabel: "1 Points (Team: 5)", isWinner: true },
      ]),
    });

    const blank = makeState({
      type: "2v2",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
        { id: "c", name: "Cal" },
        { id: "d", name: "Dee" },
      ],
    });
    finish(new Scrabble(), blank, {
      scores: { a: score(0, 1), b: score(0, 1), c: score(0, 1), d: score(0, 1) },
      winners: [],
      losers: ["a", "b", "c", "d"],
    });
  });

  it("turbo rounds word length × 1.5 into gameScore", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", effects: JSON.stringify({ turbo: true }) },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new Scrabble();
    game.onInit(state);
    setSharedGameData(state, {
      letters: ["C", "A", "T", "S", "S"],
      foundWords: { a: [], b: [] },
    });
    game.onMessage(client("a"), { action: "submit_word", word: "cat" }, state);
    game.onMessage(client("b"), { action: "submit_word", word: "at" }, state);
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      gameScores: { a: 5, b: 2 },
    });
  });
});

describe("Screen Painting", () => {
  it("MIN-015 a timeout tie goes to the earliest selected player, not every tied player", () => {
    const allTied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 50 },
        { id: "b", name: "Bea", gameScore: 50 },
        { id: "c", name: "Cal", gameScore: 50 },
      ],
    });
    finish(new ScreenPainting(), allTied, {
      scores: { a: score(3), b: score(0, 1), c: score(0, 1) },
      winners: ["a"],
      losers: ["b", "c"],
      result: board("Painting Race Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 50, scoreLabel: "50% Painted", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 50, scoreLabel: "50% Painted", isWinner: false },
        { playerId: "c", playerName: "Cal", scoreValue: 50, scoreLabel: "50% Painted", isWinner: false },
      ]),
    });

    const leadTied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 10 },
        { id: "b", name: "Bea", gameScore: 40 },
        { id: "c", name: "Cal", gameScore: 40 },
      ],
    });
    finish(new ScreenPainting(), leadTied, {
      scores: { a: score(0, 1), b: score(3), c: score(0, 1) },
      winners: ["b"],
      losers: ["a", "c"],
    });
  });

  it("a unique coverage leader wins even if they are not first", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 20 },
        { id: "b", name: "Bea", gameScore: 80 },
      ],
    });
    finish(new ScreenPainting(), state, {
      scores: { a: score(0, 1), b: score(3) },
      winners: ["b"],
      losers: ["a"],
    });
  });

  it("everyone drinks when nobody painted", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    finish(new ScreenPainting(), state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("the player who finishes takes the win", () => {
    const state = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 90 },
        { id: "b", name: "Bea", gameScore: 10 },
        { id: "c", name: "Cal", gameScore: 10 },
      ],
    });
    const game = new ScreenPainting();
    game.onMessage(client("b"), { action: "finished" }, state);
    finish(game, state, {
      scores: { a: score(0, 1), b: score(3), c: score(0, 1) },
      winners: ["b"],
      losers: ["a", "c"],
      gameScores: { a: 90, b: 100, c: 10 },
    });
  });
});

describe("Perfection", () => {
  it("SCO-007 a timeout tie shares the win, and a higher placement wins alone", () => {
    const tied = makeState({
      type: "BR",
      players: [
        { id: "a", name: "Ada", gameScore: 8 },
        { id: "b", name: "Bea", gameScore: 8 },
        { id: "c", name: "Cal", gameScore: 3 },
      ],
    });
    finish(new Perfection(), tied, {
      scores: { a: score(3), b: score(3), c: score(0, 1) },
      winners: ["a", "b"],
      losers: ["c"],
      result: board("Perfection Placement Results", [
        { playerId: "a", playerName: "Ada", scoreValue: 8, scoreLabel: "8 Matched", isWinner: true },
        { playerId: "b", playerName: "Bea", scoreValue: 8, scoreLabel: "8 Matched", isWinner: true },
        { playerId: "c", playerName: "Cal", scoreValue: 3, scoreLabel: "3 Matched", isWinner: false },
      ]),
    });

    const ahead = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 4 },
        { id: "b", name: "Bea", gameScore: 9 },
      ],
    });
    finish(new Perfection(), ahead, {
      scores: { a: score(0, 1), b: score(3) },
      winners: ["b"],
      losers: ["a"],
    });
  });

  it("everyone drinks when nobody placed a shape", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    finish(new Perfection(), state, {
      scores: { a: score(0, 1), b: score(0, 1) },
      winners: [],
      losers: ["a", "b"],
    });
  });

  it("the player who places all 16 shapes wins", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada" },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new Perfection();
    game.onInit(state);
    repeat(3, () => game.onMessage(client("b"), { action: "place" }, state));
    repeat(16, () => game.onMessage(client("a"), { action: "place" }, state));
    finish(game, state, {
      scores: { a: score(3), b: score(0, 1) },
      winners: ["a"],
      losers: ["b"],
      gameScores: { a: 16, b: 3 },
    });
  });
});

describe("Double Points", () => {
  it("adds +6 for a winning holder and no points for a losing holder", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 5, effects: JSON.stringify({ doublePoints: true }) },
        { id: "b", name: "Bea", gameScore: 1, effects: JSON.stringify({ doublePoints: true }) },
      ],
    });
    settle(new TappingRace(), state);
    assert.equal(player(state, "a").score, 3);
    assert.equal(player(state, "b").score, 0);
    assert.equal(player(state, "b").drinks, 1);

    resolveRound(state);

    assert.equal(player(state, "a").score, 6);
    assert.equal(player(state, "b").score, 0);
    assert.equal(player(state, "b").drinks, 1);
    assert.equal(player(state, "a").drinks, 0);
    assert.equal(player(state, "a").activeEffects, "");
    assert.equal(player(state, "b").activeEffects, "");
    assert.deepEqual(state.lastWinners.toArray(), ["a"]);
    assert.deepEqual(state.lastLosers.toArray(), ["b"]);
  });

  it("doubles only the tied winner who holds the card", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 4, effects: JSON.stringify({ turbo: true, doublePoints: true }) },
        { id: "b", name: "Bea", gameScore: 4 },
      ],
    });
    settle(new TappingRace(), state);
    resolveRound(state);
    assert.equal(player(state, "a").score, 6);
    assert.equal(player(state, "b").score, 3);
    assert.equal(player(state, "a").drinks, 0);
    assert.equal(player(state, "b").drinks, 0);
  });

  it("keeps turbo on the mini-game score while Double Points only affects the lobby score", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", effects: JSON.stringify({ turbo: true, doublePoints: true }) },
        { id: "b", name: "Bea" },
      ],
    });
    const game = new TappingRace();
    game.onInit(state);
    repeat(2, () => game.onMessage(client("a"), { action: "tap" }, state));
    repeat(2, () => game.onMessage(client("b"), { action: "tap" }, state));
    settle(game, state);
    assert.equal(player(state, "a").gameScore, 3);
    assert.equal(player(state, "b").gameScore, 2);
    resolveRound(state);
    assert.equal(player(state, "a").score, 6);
    assert.equal(player(state, "b").score, 0);
    assert.equal(player(state, "b").drinks, 1);
    assert.equal(player(state, "a").gameScore, 3);
  });

  it("ignores corrupt activeEffects", () => {
    const state = makeState({
      type: "1v1",
      players: [
        { id: "a", name: "Ada", gameScore: 5, effects: "{" },
        { id: "b", name: "Bea", gameScore: 1 },
      ],
    });
    settle(new TappingRace(), state);
    resolveRound(state);
    assert.equal(player(state, "a").score, 3);
    assert.equal(player(state, "b").drinks, 1);
  });
});
