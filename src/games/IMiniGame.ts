import { Client } from "@colyseus/core";
import { LobbyState } from "../rooms/schema/LobbyState";

/**
 * What a mini-game decided. LobbyRoom is the only place that turns this into
 * lobby points and drinks. `tiedIds` is informational: payout uses winners and
 * losers, which already encode the current tie quirks.
 */
export interface GameResult {
  /** +3 each. Same ids, same order, as lastWinners. */
  winners: string[];
  /** +1 drink each. Same ids, same order, as lastLosers. */
  losers: string[];
  /**
   * Players who shared the decisive tie.
   * Non-RPS score ties list the players who all win. A finished RPS match has
   * one winner and one loser; tied throws are replayed and are not reported
   * here. Screen Painting lists everyone at the top coverage, while only the
   * earliest selected id is a winner.
   */
  tiedIds: string[];
}

export function emptyGameResult(): GameResult {
  return { winners: [], losers: [], tiedIds: [] };
}

export interface IMiniGame {
  onInit(state: LobbyState): void;
  onMessage(client: Client, message: any, state: LobbyState): void;
  onTick(state: LobbyState): void;
  onEnd(state: LobbyState): GameResult;
  onPlayerDisconnect?(sessionId: string, state: LobbyState): void;
}
