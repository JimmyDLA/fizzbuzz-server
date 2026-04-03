import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class TappingRace implements IMiniGame {
  onInit(state: LobbyState): void {
    // Reset all selected players' transient gameScore
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) p.gameScore = 0;
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "tap") {
      const p = state.players.get(client.sessionId);
      if (p && state.selectedPlayers.includes(client.sessionId)) {
        p.gameScore += 1;
      }
    }
  }

  onTick(state: LobbyState): void {
    // No time-specific logic needed per tick for Tapping Race
  }

  onEnd(state: LobbyState): void {
    let maxScore = -1;
    let winners: string[] = [];

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        if (p.gameScore > maxScore) {
          maxScore = p.gameScore;
          winners = [id];
        } else if (p.gameScore === maxScore) {
          winners.push(id);
        }
      }
    });

    // Resolve universal variables
    state.lastWinners.clear();
    state.lastLosers.clear();

    // Award standard points
    winners.forEach(id => {
      const p = state.players.get(id);
      if (p) p.score += 3;
      state.lastWinners.push(id);
    });

    // Issue drinks penalty
    state.selectedPlayers.forEach(id => {
      if (!winners.includes(id)) {
        const p = state.players.get(id);
        if (p) p.drinks += 1;
        state.lastLosers.push(id);
      }
    });
  }
}
