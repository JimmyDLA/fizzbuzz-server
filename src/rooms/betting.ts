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
   * 0 only when the round has no placement, such as an abort.
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
  const rows = placementRows(lastGameResult);
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

function placementRows(lastGameResult: string): LeaderboardRow[] | null {
  if (!lastGameResult) return null;
  try {
    const parsed = JSON.parse(lastGameResult) as {
      leaderboard?: unknown;
      timeline?: unknown;
    };
    if (!parsed) return null;
    // Tapping, Cyclone, Lumber, Balloon, Simon, Scrabble, Screen Painting, and
    // Perfection report scoreValue on leaderboard. Math and Trivia report it
    // on timeline. Hot Potato and Rock Paper Scissors have no scoreValue.
    for (const key of ["leaderboard", "timeline"] as const) {
      const rows = parsed[key];
      if (!Array.isArray(rows)) continue;
      const scored = (rows as LeaderboardRow[]).filter((row) => (
        typeof row?.playerId === "string"
        && typeof row.scoreValue === "number"
        && Number.isFinite(row.scoreValue)
      ));
      if (scored.length > 0) return scored;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pot split. Rank weight is n for 1st down to 1 for last. Tied players each
 * take the weight of the best rank they share. A stake of 0 pays 0.
 * Exact share is pot × (stake × weight) / Σ(stake × weight). Omit `stakes`
 * to give every player a stake of 1, which is the plain-rank split.
 * Each player is floored. Leftover points are handed out in passes from the
 * top rank group down: a group receives +1 per eligible member only when the
 * leftover covers the whole group, otherwise that group is skipped. In the
 * stake-weighted split only members with a stake above 0 are eligible.
 * If no group fits, the leftover goes out one point at a time by earliest
 * input order. That is the only time tied players differ by 1. The shares
 * add up to `pot`.
 */
export function splitPot(
  placements: readonly Placement[],
  pot: number,
  stakes?: Readonly<Record<string, number>>,
): PayoutShare[] {
  const n = placements.length;
  if (n === 0) return [];

  const safePot = Number.isFinite(pot) ? Math.max(0, Math.floor(pot)) : 0;
  const ordered = placements.map((placement, order) => ({
    ...placement,
    order,
    stake: stakes
      ? Math.max(0, Math.floor(stakes[placement.playerId] ?? 0))
      : 1,
  }));
  ordered.sort((a, b) => {
    if (a.standing !== b.standing) return b.standing - a.standing;
    return a.order - b.order;
  });

  interface Member {
    playerId: string;
    rank: number;
    stake: number;
    weight: number;
    order: number;
    floor: number;
  }

  const groups: Member[][] = [];
  let index = 0;
  while (index < ordered.length) {
    const standing = ordered[index].standing;
    let end = index + 1;
    while (end < ordered.length && ordered[end].standing === standing) end += 1;
    const rank = index + 1;
    const weight = n - rank + 1;
    const group: Member[] = [];
    for (let cursor = index; cursor < end; cursor += 1) {
      group.push({
        playerId: ordered[cursor].playerId,
        rank,
        stake: ordered[cursor].stake,
        weight,
        order: ordered[cursor].order,
        floor: 0,
      });
    }
    groups.push(group);
    index = end;
  }

  const members = groups.flat();
  const weightTotal = members.reduce((sum, member) => sum + member.stake * member.weight, 0);
  if (weightTotal === 0 || safePot === 0) {
    return members.map((member) => ({
      playerId: member.playerId,
      rank: member.rank,
      payout: 0,
    }));
  }

  for (const member of members) {
    member.floor = Math.floor((safePot * member.stake * member.weight) / weightTotal);
  }
  let leftover = safePot - members.reduce((sum, member) => sum + member.floor, 0);
  const extra = new Map<string, number>();
  const give = (member: Member) => {
    extra.set(member.playerId, (extra.get(member.playerId) ?? 0) + 1);
  };
  const eligibleIn = (group: Member[]) => group.filter((member) => member.stake > 0);

  while (leftover > 0) {
    let gave = false;
    for (const group of groups) {
      const eligible = eligibleIn(group);
      if (eligible.length === 0 || leftover < eligible.length) continue;
      for (const member of eligible) give(member);
      leftover -= eligible.length;
      gave = true;
    }
    if (gave) continue;
    const earliest = groups.flatMap((group) => eligibleIn(group)).sort((a, b) => a.order - b.order);
    for (const member of earliest) {
      if (leftover <= 0) break;
      give(member);
      leftover -= 1;
    }
    break;
  }

  return members.map((member) => ({
    playerId: member.playerId,
    rank: member.rank,
    payout: member.floor + (extra.get(member.playerId) ?? 0),
  }));
}
