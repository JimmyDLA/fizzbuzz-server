/**
 * Match length and the end-of-match podium.
 *
 * The round index the chart is showing is the only start-of-round hook.
 * Betting (every 5th round, including a final round when the length is a
 * multiple of 5) reads `roundCount` from here. Wagers, the forced Battle
 * Royale mode, and the pot payout live in `betting.ts`. This module does
 * not move points.
 */

export const ROUND_CHOICES = [10, 15, 20, 30, 40, 50] as const;
export type RoundChoice = (typeof ROUND_CHOICES)[number];
export const DEFAULT_TOTAL_ROUNDS: RoundChoice = 10;

export const SET_ROUNDS_MESSAGE = "set_rounds";
export const GAME_OVER_EVENT = "GameOverEvent";

export function isRoundChoice(value: unknown): value is RoundChoice {
  return typeof value === "number"
    && Number.isInteger(value)
    && (ROUND_CHOICES as readonly number[]).includes(value);
}

/**
 * 1-based index of the round that has not resolved yet.
 * The chart shows this number. Starting the wheel does not advance it again.
 */
export function upcomingRoundNumber(resolvedRounds: number): number {
  return resolvedRounds + 1;
}

export interface RankedPlayer {
  id: string;
  name: string;
  score: number;
}

export interface PodiumSeat {
  place: number;
  playerId: string;
  name: string;
  score: number;
}

export interface GameOverPayload {
  roundCount: number;
  totalRounds: number;
  podium: PodiumSeat[];
}

/**
 * Competition ranking for places 1, 2, and 3.
 * Tied scores share a place and the next place skips by the size of the tie:
 * two players on the top score are both place 1, and the next score is place 3.
 * Everyone on a place of 1, 2, or 3 is included, so a tie can put more than
 * three players on the podium. A place above 3 is omitted. Fewer than three
 * distinct places omit the missing ones. Within a shared place, seats are
 * ordered by player id. That order is not a rank. Points are the only input.
 */
export function buildPodium(players: readonly RankedPlayer[]): PodiumSeat[] {
  const ranked = [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const seats: PodiumSeat[] = [];
  let index = 0;
  while (index < ranked.length) {
    const score = ranked[index].score;
    let end = index + 1;
    while (end < ranked.length && ranked[end].score === score) end += 1;
    const place = index + 1;
    if (place > 3) break;
    for (let cursor = index; cursor < end; cursor += 1) {
      const player = ranked[cursor];
      seats.push({
        place,
        playerId: player.id,
        name: player.name,
        score,
      });
    }
    index = end;
  }
  return seats;
}
