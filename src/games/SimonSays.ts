import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class SimonSays implements IMiniGame {
  onInit(state: LobbyState): void {
    const activePlayers = state.selectedPlayers.toArray();
    const sequence = [Math.floor(Math.random() * 4)];
    
    const gameData = {
      phase: "watch",
      sequence,
      currentRound: 1,
      activePlayers,
      failedPlayers: [] as string[],
      progress: {} as Record<string, number>
    };

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify(gameData);
      }
    });

    state.timer = this.calculateWatchTime(sequence.length);
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "tap") {
      const id = client.sessionId;
      const firstPlayer = state.players.get(state.selectedPlayers[0]);
      if (!firstPlayer) return;

      let gameData: any;
      try { gameData = JSON.parse(firstPlayer.gameData); } catch (e) { return; }

      if (gameData.phase !== "input") return;
      if (!gameData.activePlayers.includes(id)) return;

      const progress = gameData.progress[id] || 0;
      
      // If the player has already completed the sequence for this round, ignore extra taps.
      if (progress >= gameData.sequence.length) return;

      const expected = gameData.sequence[progress];

      if (message.color === expected) {
        gameData.progress[id] = progress + 1;

        if (gameData.progress[id] === gameData.sequence.length) {
          const p = state.players.get(id);
          if (p) p.gameScore = gameData.currentRound;
        }

        let allFinished = true;
        gameData.activePlayers.forEach((pId: string) => {
          if ((gameData.progress[pId] || 0) < gameData.sequence.length) {
            allFinished = false;
          }
        });

        if (allFinished) {
          state.timer = 1; // Force phase transition soon
        }
      } else {
        // Wrong color -> elimination
        gameData.failedPlayers.push(id);
        gameData.activePlayers = gameData.activePlayers.filter((pId: string) => pId !== id);
        
        const isMultiplayer = state.selectedPlayers.length > 1;
        if (gameData.activePlayers.length === 0 || (isMultiplayer && gameData.activePlayers.length <= 1)) {
          state.timer = 1;
          gameData.isGameOver = true;
          gameData.winners = this.computeWinners(state, gameData);
        }
      }

      this.syncGameData(state, gameData);
    }
  }

  onTick(state: LobbyState): void {
    // Only act when timer is 1 (right before it naturally hits 0 and ends the game in LobbyRoom)
    if (state.timer > 1) return; 

    const firstPlayerId = state.selectedPlayers[0];
    const firstPlayer = state.players.get(firstPlayerId);
    if (!firstPlayer) return;

    let gameData: any;
    try {
      gameData = JSON.parse(firstPlayer.gameData);
    } catch (e) {
      return;
    }

    if (gameData.phase === "watch") {
      gameData.phase = "input";
      gameData.activePlayers.forEach((id: string) => {
        gameData.progress[id] = 0;
      });
      state.timer = this.calculateInputTime(gameData.sequence.length) + 1; 
      // +1 because timer will immediately decrement to the correct value next loop
    } else if (gameData.phase === "input") {
      const seqLen = gameData.sequence.length;
      const newlyFailed: string[] = [];

      gameData.activePlayers.forEach((id: string) => {
        if ((gameData.progress[id] || 0) < seqLen) {
          newlyFailed.push(id);
        }
      });

      newlyFailed.forEach(id => {
        gameData.failedPlayers.push(id);
        gameData.activePlayers = gameData.activePlayers.filter((pId: string) => pId !== id);
      });

      gameData.activePlayers.forEach((id: string) => {
        const p = state.players.get(id);
        if (p) p.gameScore = gameData.currentRound;
      });

      const isMultiplayer = state.selectedPlayers.length > 1;
      if (gameData.activePlayers.length === 0 || (isMultiplayer && gameData.activePlayers.length <= 1)) {
        state.timer = 0; // Trigger onEnd natively
        gameData.isGameOver = true;
        gameData.winners = this.computeWinners(state, gameData);
      } else {
        gameData.phase = "watch";
        gameData.currentRound++;
        gameData.sequence.push(Math.floor(Math.random() * 4));
        state.timer = this.calculateWatchTime(gameData.sequence.length) + 1;
      }
    }

    this.syncGameData(state, gameData);
  }

  onEnd(state: LobbyState): void {
    const firstPlayerId = state.selectedPlayers[0];
    const firstPlayer = state.players.get(firstPlayerId);
    let gameData: any = {};
    if (firstPlayer) {
      try { gameData = JSON.parse(firstPlayer.gameData); } catch (e) {}
    }

    const ids = state.selectedPlayers.toArray();
    let winners: string[] = this.computeWinners(state, gameData);

    // Award standard points
    state.lastWinners.clear();
    state.lastLosers.clear();

    winners.forEach(id => {
      const p = state.players.get(id);
      if (p) p.score += 3;
      state.lastWinners.push(id);
    });

    state.selectedPlayers.forEach(id => {
      if (!winners.includes(id)) {
        const p = state.players.get(id);
        if (p) p.drinks += 1;
        state.lastLosers.push(id);
      }
    });

    const leaderboard = ids.map(id => {
      const p = state.players.get(id);
      const isWinner = winners.includes(id);
      const rounds = p?.gameScore || 0;
      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue: rounds,
        scoreLabel: `Survived ${rounds} Rounds`,
        isWinner
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Simon Says Results",
      leaderboard
    });
  }

  private computeWinners(state: LobbyState, gameData: any): string[] {
    const ids = state.selectedPlayers.toArray();
    let maxScore = -1;
    ids.forEach(id => {
      const p = state.players.get(id);
      if (p && p.gameScore > maxScore) maxScore = p.gameScore;
    });

    let winners: string[] = [];
    ids.forEach(id => {
      const p = state.players.get(id);
      if (p && p.gameScore === maxScore && maxScore > 0) {
        winners.push(id);
      }
    });
    return winners;
  }

  private calculateWatchTime(sequenceLength: number): number {
    return Math.max(3, Math.ceil(sequenceLength * 0.8) + 2);
  }

  private calculateInputTime(sequenceLength: number): number {
    return Math.max(5, sequenceLength * 1 + 2);
  }

  private syncGameData(state: LobbyState, gameData: any) {
    const dataStr = JSON.stringify(gameData);
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) p.gameData = dataStr;
    });
  }
}
