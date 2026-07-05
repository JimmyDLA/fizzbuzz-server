import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class Perfection implements IMiniGame {
  private winnerId: string | null = null;
  private shapes: number[] = [];

  onInit(state: LobbyState): void {
    this.winnerId = null;

    // Generate a randomized layout of 16 shapes (indices 0 to 15)
    this.shapes = Array.from({ length: 16 }, (_, i) => i);
    for (let i = this.shapes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.shapes[i], this.shapes[j]] = [this.shapes[j], this.shapes[i]];
    }

    const gameData = {
      finished: false,
      winnerId: null as string | null,
      shapes: this.shapes,
    };

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0; // tracks number of correctly placed shapes
        p.gameData = JSON.stringify(gameData);
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (this.winnerId) return;

    if (message.action === "place") {
      const p = state.players.get(client.sessionId);
      if (!p || !state.selectedPlayers.includes(client.sessionId)) return;

      // Increment progress
      p.gameScore += 1;

      // Check if finished
      if (p.gameScore >= 16) {
        this.winnerId = client.sessionId;

        // Set finished state for all players
        state.selectedPlayers.forEach(id => {
          const player = state.players.get(id);
          if (player) {
            player.gameData = JSON.stringify({
              finished: true,
              winnerId: this.winnerId,
              shapes: this.shapes,
            });
          }
        });

        // Terminate play immediately
        state.timer = 1;
      }
    }
  }

  onTick(state: LobbyState): void {
    // No tick logic needed
  }

  onEnd(state: LobbyState): void {
    let winners: string[] = [];
    const ids = state.selectedPlayers.toArray();

    if (this.winnerId) {
      winners = [this.winnerId];
    } else {
      // Timeout fallback: find who matched the most shapes
      let maxScore = 0;
      ids.forEach(id => {
        const p = state.players.get(id);
        if (p && p.gameScore > maxScore) {
          maxScore = p.gameScore;
        }
      });

      if (maxScore > 0) {
        ids.forEach(id => {
          const p = state.players.get(id);
          if (p && p.gameScore === maxScore) {
            winners.push(id);
          }
        });
      }
    }

    state.lastWinners.clear();
    state.lastLosers.clear();

    ids.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        if (winners.includes(id)) {
          p.score += 3;
          state.lastWinners.push(id);
        } else {
          p.drinks += 1;
          state.lastLosers.push(id);
        }
      }
    });

    const leaderboard = ids.map(id => {
      const p = state.players.get(id);
      const score = p?.gameScore || 0;
      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue: score,
        scoreLabel: `${score} Matched`,
        isWinner: winners.includes(id)
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Perfection Placement Results",
      leaderboard
    });
  }
}
