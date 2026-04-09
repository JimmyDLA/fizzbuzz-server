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
    let winners: string[] = [];
    const ids = state.selectedPlayers.toArray();

    if (state.currentGameType === "2v2" && ids.length === 4) {
      const t1Score = (state.players.get(ids[0])?.gameScore || 0) + (state.players.get(ids[1])?.gameScore || 0);
      const t2Score = (state.players.get(ids[2])?.gameScore || 0) + (state.players.get(ids[3])?.gameScore || 0);

      if (t1Score >= t2Score) winners.push(ids[0], ids[1]);
      if (t2Score >= t1Score) winners.push(ids[2], ids[3]);
    } else {
      let maxScore = -1;
      ids.forEach(id => {
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
    }

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
