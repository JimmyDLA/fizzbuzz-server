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
      roundStartActivePlayers: [...activePlayers],
      failedPlayers: [] as string[],
      progress: {} as Record<string, number>,
      isGameOver: false,
      winners: [] as string[]
    };

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify(gameData);
      }
    });

    state.timer = this.calculateWatchTime(sequence.length, 1);
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "tap") {
      const id = client.sessionId;
      const firstPlayer = state.players.get(state.selectedPlayers[0]);
      if (!firstPlayer) return;

      let gameData: any;
      try { gameData = JSON.parse(firstPlayer.gameData); } catch (e) { return; }

      if (gameData.isGameOver) return;
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
          const isMultiplayer = state.selectedPlayers.length > 1;
          if (isMultiplayer && gameData.activePlayers.length === 1) {
            // The last remaining player completed the round successfully!
            gameData.isGameOver = true;
            gameData.winners = [gameData.activePlayers[0]];
            state.timer = 0;
          } else {
            state.timer = 0; // Trigger onTick phase transition
          }
        }
      } else {
        // Wrong color -> elimination
        gameData.failedPlayers.push(id);
        gameData.activePlayers = gameData.activePlayers.filter((pId: string) => pId !== id);
        
        const isMultiplayer = state.selectedPlayers.length > 1;
        if (gameData.activePlayers.length === 0) {
          gameData.isGameOver = true;
          // Tie between all players who started the current round active, unless it's round 1 (nobody completed round 1)
          if (gameData.currentRound === 1) {
            gameData.winners = [];
          } else {
            gameData.winners = isMultiplayer ? (gameData.roundStartActivePlayers || []) : [];
          }
          state.timer = 0;
        }
        // Note: we do NOT end the game if gameData.activePlayers.length === 1.
        // We let that last player continue inputting to see if they get it right.
      }

      this.syncGameData(state, gameData);
    }
  }

  onTick(state: LobbyState): void {
    // Only act when timer is 0 or less
    if (state.timer > 0) return; 

    const firstPlayerId = state.selectedPlayers[0];
    const firstPlayer = state.players.get(firstPlayerId);
    if (!firstPlayer) return;

    let gameData: any;
    try {
      gameData = JSON.parse(firstPlayer.gameData);
    } catch (e) {
      return;
    }

    if (gameData.isGameOver) return;

    if (gameData.phase === "watch") {
      gameData.phase = "input";
      gameData.activePlayers.forEach((id: string) => {
        gameData.progress[id] = 0;
      });
      state.timer = this.calculateInputTime(gameData.sequence.length);
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
      if (gameData.activePlayers.length === 0) {
        state.timer = 0; // Trigger onEnd natively
        gameData.isGameOver = true;
        if (gameData.currentRound === 1) {
          gameData.winners = [];
        } else {
          gameData.winners = isMultiplayer ? (gameData.roundStartActivePlayers || []) : [];
        }
      } else if (isMultiplayer && gameData.activePlayers.length === 1) {
        // Since B completed it correctly (not in newlyFailed) and is the last active player, they win!
        state.timer = 0;
        gameData.isGameOver = true;
        gameData.winners = [gameData.activePlayers[0]];
      } else {
        gameData.phase = "watch";
        gameData.currentRound++;
        gameData.sequence.push(Math.floor(Math.random() * 4));
        gameData.roundStartActivePlayers = [...gameData.activePlayers];
        state.timer = this.calculateWatchTime(gameData.sequence.length, gameData.currentRound);
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
    let winners: string[] = gameData.winners || [];

    // Fallback: if game ended without winners being set (e.g. maximum room timer expired),
    // then the remaining active players are the winners!
    if (winners.length === 0 && gameData.activePlayers && gameData.activePlayers.length > 0) {
      winners = [...gameData.activePlayers];
    }

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

  private calculateWatchTime(sequenceLength: number, round: number): number {
    const speedFactor = Math.max(0.4, 1 - (round - 1) * 0.15);
    const onDuration = 500 * speedFactor;
    const offDuration = 250 * speedFactor;
    const totalPlayTimeSec = 1.0 + (sequenceLength * (onDuration + offDuration)) / 1000;
    return Math.max(3, Math.ceil(totalPlayTimeSec));
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
