import { GameResult } from "../games/IMiniGame";
import { LobbyState } from "./schema/LobbyState";

function connectedContestants(state: LobbyState): string[] {
  return state.selectedPlayers
    .toArray()
    .filter(id => state.players.has(id) && state.players.get(id)?.isConnected);
}

function markNoWinners(state: LobbyState): void {
  if (!state.lastGameResult) return;
  let parsed: any;
  try {
    parsed = JSON.parse(state.lastGameResult);
  } catch {
    return;
  }
  for (const key of ["leaderboard", "timeline"] as const) {
    const rows = parsed?.[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && typeof row === "object") row.isWinner = false;
    }
  }
  state.lastGameResult = JSON.stringify(parsed);
}

/**
 * When nobody acts, every contestant scores 0 and everyone drinks.
 * A reported win is dropped. A tie with any score above 0 stays as reported.
 * Games that omit actionScores (Hot Potato, Rock Paper Scissors, Simon Says)
 * are left alone.
 */
export function applyNoActionRound(state: LobbyState, result: GameResult): GameResult {
  const scores = result.actionScores;
  if (!scores) return result;

  const contestants = connectedContestants(state);
  if (contestants.length === 0) return result;
  if (!contestants.every(id => scores[id] === 0)) return result;

  state.lastWinners.clear();
  state.lastLosers.clear();
  for (const id of contestants) state.lastLosers.push(id);
  markNoWinners(state);

  return {
    winners: [],
    losers: contestants,
    tiedIds: [],
    actionScores: scores,
  };
}

/**
 * The only +3 / +1 drink payout for a mini-game. Games report a GameResult and
 * must not write player.score or player.drinks.
 * A tie is not re-decided here: winners and losers already say who won and who drinks.
 */
export function applyStandardScoring(state: LobbyState, result: GameResult): void {
  for (const id of result.winners) {
    const player = state.players.get(id);
    if (player) player.score += 3;
  }
  for (const id of result.losers) {
    const player = state.players.get(id);
    if (player) player.drinks += 1;
  }
}

/** No-action rewrite, then the shared +3 / +1 drink payout. */
export function scoreGameResult(state: LobbyState, result: GameResult): GameResult {
  const resolved = applyNoActionRound(state, result);
  applyStandardScoring(state, resolved);
  return resolved;
}

/**
 * Extra +3 for each winning player who has Double Points active.
 * Applied at resolution, after the standard +3, so a winning holder ends at +6.
 * Losers are not in lastWinners, so a losing holder gets no points.
 */
export function applyDoublePoints(state: LobbyState): void {
  state.lastWinners.forEach(winnerId => {
    const p = state.players.get(winnerId);
    if (p && p.activeEffects) {
      try {
        const fx = JSON.parse(p.activeEffects);
        if (fx.doublePoints) {
          p.score += 3; // Extra +3 score to double standard +3 win points to +6
          console.log(`[SpecialtyCard] ${p.name} earned DOUBLE POINTS (+6 total)!`);
        }
      } catch (e) {}
    }
  });
}
