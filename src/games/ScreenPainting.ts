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
    if (!state.selectedPlayers.includes(client.sessionId)) return;

    if (message.action === "progress") {
      const p = state.players.get(client.sessionId);
      if (p && !this.winnerId) {
        p.gameScore = Math.min(100, Math.max(0, message.coverage || 0));
      }
    }

    if (message.action === "finished" && !this.winnerId) {
      this.winnerId = client.sessionId;

      // Update all selected players' game data to mark game as finished and specify the winner
      state.selectedPlayers.forEach(id => {
        const player = state.players.get(id);
        if (player) {
          if (id === client.sessionId) {
            player.gameScore = 100;
          }
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
      // Timeout - find player with highest coverage
      let highestCoverage = -1;
      let topPlayerId: string | null = null;
      state.selectedPlayers.forEach(id => {
        const p = state.players.get(id);
        const score = p?.gameScore || 0;
        if (score > highestCoverage) {
          highestCoverage = score;
          topPlayerId = id;
        }
      });

      if (topPlayerId && highestCoverage > 0) {
        this.winnerId = topPlayerId;
        state.lastWinners.push(topPlayerId);
        const winner = state.players.get(topPlayerId);
        if (winner) winner.score += 3;

        state.selectedPlayers.forEach(id => {
          if (id !== topPlayerId) {
            state.lastLosers.push(id);
            const p = state.players.get(id);
            if (p) p.drinks += 1;
          }
        });
      } else {
        // Everyone loses
        state.selectedPlayers.forEach(id => {
          state.lastLosers.push(id);
          const p = state.players.get(id);
          if (p) p.drinks += 1;
        });
      }
    }

    // Set leaderboard data for the resolution / results screen
    const leaderboard = state.selectedPlayers.toArray().map(id => {
      const p = state.players.get(id);
      const isWinner = id === this.winnerId;
      const coveragePct = Math.min(100, Math.max(0, p?.gameScore || 0));
      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue: coveragePct,
        scoreLabel: `${coveragePct}% Painted`,
        isWinner
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Painting Race Results",
      leaderboard
    });
  }
}
