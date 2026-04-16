import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class ScreenPainting implements IMiniGame {
  private winnerId: string | null = null;

  onInit(state: LobbyState): void {
    this.winnerId = null;
    let colorIndex = 0;
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify({ finished: false, colorIndex: colorIndex % 7 });
        colorIndex++;
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "finished" && !this.winnerId) {
      if (!state.selectedPlayers.includes(client.sessionId)) return;

      this.winnerId = client.sessionId;
      const p = state.players.get(client.sessionId);
      if (p) {
        p.gameScore = 100;
        p.gameData = JSON.stringify({ finished: true });
      }

      // Broadcast to others that someone finished
      state.selectedPlayers.forEach(id => {
         const player = state.players.get(id);
         if (player && id !== client.sessionId) {
            player.gameData = JSON.stringify({ finished: true, winnerId: client.sessionId });
         }
      });

      // End game immediately
      state.timer = 1; 
    }
  }

  onTick(state: LobbyState): void {
    // No tick logic needed for now
  }

  onEnd(state: LobbyState): void {
    state.lastWinners.clear();
    state.lastLosers.clear();

    if (this.winnerId) {
      state.lastWinners.push(this.winnerId);
      const winner = state.players.get(this.winnerId);
      if (winner) winner.score += 3;

      state.selectedPlayers.forEach(id => {
        if (id !== this.winnerId) {
          state.lastLosers.push(id);
          const p = state.players.get(id);
          if (p) p.drinks += 1;
        }
      });
    } else {
      // Timeout
      state.selectedPlayers.forEach(id => {
        state.lastLosers.push(id);
        const p = state.players.get(id);
        if (p) p.drinks += 1;
      });
    }
  }
}
