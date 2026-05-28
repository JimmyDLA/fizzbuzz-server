import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class LumberCut implements IMiniGame {
  onInit(state: LobbyState): void {
    const players = state.selectedPlayers.toArray();
    const type = state.currentGameType;

    const teams: any[] = [];
    if (type === "2v2" && players.length >= 4) {
      teams.push({ id: "Team 1", members: [players[0], players[1]], pairs: 0, next: 'left' });
      teams.push({ id: "Team 2", members: [players[2], players[3]], pairs: 0, next: 'left' });
    } else {
      // 1v1 or BR assigns everyone their own isolated solo 'team' container
      players.forEach((p, i) => {
        const playerEntity = state.players.get(p);
        teams.push({ id: playerEntity ? playerEntity.name : `Solo ${i+1}`, members: [p], pairs: 0, next: 'left' });
      });
    }

    const gameData = {
      teams,
      targetPairs: 20,
      gameOver: false,
      winners: [] as string[]
    };

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0; 
        p.gameData = JSON.stringify(gameData);
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "pull") {
      const p = state.players.get(client.sessionId);
      if (!p || !state.selectedPlayers.includes(client.sessionId)) return;

      const currentDataString = state.players.get(state.selectedPlayers[0])?.gameData || "{}";
      const gameData = JSON.parse(currentDataString);
      if (gameData.gameOver) return;

      const team = gameData.teams.find((t: any) => t.members.includes(client.sessionId));
      if (!team) return;

      // Validate button assignment constraints organically in team setups
      if (team.members.length > 1) {
        const isLeftPuller = team.members[0] === client.sessionId;
        if (isLeftPuller && message.side !== 'left') return; // Left puller strictly pulls left
        if (!isLeftPuller && message.side !== 'right') return; // Right puller strictly pulls right
      }

      if (team.next === message.side) {
        team.next = message.side === 'left' ? 'right' : 'left';
        if (message.side === 'right') { 
          // Reaching the right pull concludes a cohesive cross-cut sequence
          team.pairs++;
        }

        if (team.pairs >= gameData.targetPairs) {
          gameData.gameOver = true;
          gameData.winners = team.members;
          state.timer = 2; // Victory animation delay hook
        }

        // Synchronize evaluated team movements
        state.selectedPlayers.forEach(id => {
          const player = state.players.get(id);
          if (player) player.gameData = JSON.stringify(gameData);
        });
      }
    }
  }

  onTick(state: LobbyState): void {}

  onEnd(state: LobbyState): void {
    const gameData = JSON.parse(state.players.get(state.selectedPlayers[0])?.gameData || "{}");
    let winners: string[] = gameData.winners || [];

    // Fallback: If timer expires without a full log severance, calculate the furthest pairing natively
    if (!gameData.gameOver || winners.length === 0) {
      let maxPairs = -1;
      let winningTeams: any[] = [];
      gameData.teams.forEach((t: any) => {
        if (t.pairs > maxPairs) {
          maxPairs = t.pairs;
          winningTeams = [t];
        } else if (t.pairs === maxPairs) {
          winningTeams.push(t);
        }
      });
      
      winners = [];
      winningTeams.forEach(t => winners.push(...t.members));
    }

    state.lastWinners.clear();
    state.lastLosers.clear();

    state.selectedPlayers.forEach(id => {
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

    const is2v2 = state.currentGameType === "2v2" && state.selectedPlayers.length === 4;

    const leaderboard = state.selectedPlayers.toArray().map(id => {
      const p = state.players.get(id);
      const team = gameData.teams?.find((t: any) => t.members.includes(id));
      const pairs = team ? team.pairs : 0;
      const scoreLabel = is2v2 ? `${pairs} Team Logs Cut` : `${pairs} Logs Cut`;
      
      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue: pairs,
        scoreLabel,
        isWinner: state.lastWinners.includes(id)
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Logs Cut",
      leaderboard
    });
  }
}
