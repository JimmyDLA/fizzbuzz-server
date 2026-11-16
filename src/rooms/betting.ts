import { GameResult } from "../games/IMiniGame";

/**
 * Every 5th round is a betting round. Points are the coins.
 * The wheel still picks the mini-game, and the mode is Battle Royale.
 * The pot payout replaces the normal +3. Drinks still come from the game result.
 */

export const BETTING_STAKE = 3;

export const BETTING_ROUND_EVENT = "BettingRoundEvent";
export const BETTING_PAYOUT_EVENT = "BettingPayoutEvent";

export function isBettingRound(roundCount: number): boolean {
  return Number.isInteger(roundCount) && roundCount > 0 && roundCount % 5 === 0;
}

/**
 * min(3, points the player currently has), never below 0.
 * A fractional point total wagers the whole points below it.
 */
export function wagerForPoints(points: number): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.min(BETTING_STAKE, Math.floor(points));
}

export interface BettingWagerView {
  playerId: string;
  name: string;
  wager: number;
}

export interface BettingRoundPayload {
  roundCount: number;
  pot: number;
  /** Betting rounds are always Battle Royale. */
  mode: "BR";
  wagers: BettingWagerView[];
}

export interface BettingPayoutView {
  playerId: string;
  name: string;
  wager: number;
  payout: number;
  /** payout − wager. This is the scoreboard delta for the round. */
  net: number;
  /**
   * 1-based competition rank. Tied players share the best rank in the tie
   * (two players tied for 1st are both rank 1, and the next player is rank 3).
   * 0 when the round was refunded and nobody was placed.
   */
  rank: number;
}

/** Why the pot moved back out to players. */
export type BettingPayoutReason = "payout" | "no-action" | "aborted" | "unresolved";

export interface BettingPayoutPayload {
  roundCount: number;
  pot: number;
  refunded: boolean;
  reason: BettingPayoutReason;
  payouts: BettingPayoutView[];
}

export interface Placement {
  playerId: string;
  /** Higher is better. Equal values tie and share the average of those ranks' weights. */
  standing: number;
}

export interface PayoutShare {
  playerId: string;
  rank: number;
  payout: number;
}

/**
 * No winner means there is no placement to pay, so the pot is refunded.
 * `applyNoActionRound` has already turned an all-zero `actionScores` report
 * into this shape (Lumber Cut with no finished cut, Turbo on a blank board).
 * A game that already reports no winners (a zero board, a Simon Says round-0
 * timeout, an RPS tie) refunds the same way. Drinks still apply.
 */
export function isNoActionResult(result: GameResult): boolean {
  return result.winners.length === 0;
}

interface LeaderboardRow {
  playerId?: unknown;
  scoreValue?: unknown;
}

/**
 * Standings for the players who wagered.
 * A leaderboard with numeric `scoreValue` is the placement (higher is better).
 * Cyclone already stores the negated distance there, so closer is higher.
 * Elimination games such as Hot Potato omit `scoreValue`. Winners then share
 * the top standing and losers share the bottom. Anyone the game did not list
 * finishes last, tied with other unlisted players.
 */
export function standingsForPlayers(
  playerIds: readonly string[],
  result: GameResult,
  lastGameResult: string,
): Placement[] {
  const rows = leaderboardRows(lastGameResult);
  const scoreById = new Map<string, number>();
  let usedScores = false;
  if (rows) {
    for (const row of rows) {
      if (typeof row.playerId !== "string") continue;
      if (typeof row.scoreValue === "number" && Number.isFinite(row.scoreValue)) {
        scoreById.set(row.playerId, row.scoreValue);
        usedScores = true;
      }
    }
  }

  if (!usedScores) {
    const winners = new Set(result.winners);
    const losers = new Set(result.losers);
    for (const id of playerIds) {
      if (winners.has(id)) scoreById.set(id, 1);
      else if (losers.has(id)) scoreById.set(id, 0);
      else scoreById.set(id, -1);
    }
  }

  return playerIds.map((playerId) => ({
    playerId,
    standing: scoreById.has(playerId) ? scoreById.get(playerId)! : Number.NEGATIVE_INFINITY,
  }));
}

function leaderboardRows(lastGameResult: string): LeaderboardRow[] | null {
  if (!lastGameResult) return null;
  try {
    const parsed = JSON.parse(lastGameResult) as { leaderboard?: unknown };
    if (!parsed || !Array.isArray(parsed.leaderboard)) return null;
    return parsed.leaderboard as LeaderboardRow[];
  } catch {
    return null;
  }
}

/**
 * Rank-weighted pot split. 1st has weight n, 2nd n−1, ..., last 1.
 * Tied players use the average of the weights for the ranks they occupy.
 * Each share is floored, then leftover points go out one at a time to the
 * largest remainders. An equal remainder goes to the better rank, then to
 * the earlier input order. The shares add up to `pot`.
 */
export function splitPot(placements: readonly Placement[], pot: number): PayoutShare[] {
  const n = placements.length;
  if (n === 0) return [];

  const totalWeight = (n * (n + 1)) / 2;
  const safePot = Number.isFinite(pot) ? Math.max(0, Math.floor(pot)) : 0;
  const ordered = placements.map((placement, order) => ({ ...placement, order }));
  ordered.sort((a, b) => {
    if (a.standing !== b.standing) return b.standing - a.standing;
    return a.order - b.order;
  });

  interface Row {
    playerId: string;
    rank: number;
    floor: number;
    remNum: number;
    remDen: number;
    order: number;
  }

  const rows: Row[] = [];
  let index = 0;
  while (index < ordered.length) {
    const standing = ordered[index].standing;
    let end = index + 1;
    while (end < ordered.length && ordered[end].standing === standing) end += 1;
    const startRank = index + 1;
    const groupSize = end - index;
    let weightSum = 0;
    for (let offset = 0; offset < groupSize; offset += 1) {
      const rank = startRank + offset;
      weightSum += n - rank + 1;
    }
    const denominator = groupSize * totalWeight;
    const numerator = safePot * weightSum;
    const floor = Math.floor(numerator / denominator);
    const remNum = numerator % denominator;
    for (let cursor = index; cursor < end; cursor += 1) {
      rows.push({
        playerId: ordered[cursor].playerId,
        rank: startRank,
        floor,
        remNum,
        remDen: denominator,
        order: ordered[cursor].order,
      });
    }
    index = end;
  }

  let leftover = safePot - rows.reduce((sum, row) => sum + row.floor, 0);
  const byRemainder = [...rows].sort((a, b) => {
    const left = a.remNum * b.remDen;
    const right = b.remNum * a.remDen;
    if (left !== right) return right - left;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.order - b.order;
  });

  const extra = new Map<string, number>();
  for (const row of byRemainder) {
    if (leftover <= 0) break;
    extra.set(row.playerId, (extra.get(row.playerId) ?? 0) + 1);
    leftover -= 1;
  }

  return rows.map((row) => ({
    playerId: row.playerId,
    rank: row.rank,
    payout: row.floor + (extra.get(row.playerId) ?? 0),
  }));
}
