import { GameResult } from "../games/IMiniGame";
import { LobbyState } from "./schema/LobbyState";

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
