import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class HotPotato implements IMiniGame {
  onInit(state: LobbyState): void {
    const players = state.selectedPlayers.toArray();
    // Start with a random player
    const randomStarter = players[Math.floor(Math.random() * players.length)];
    
    const gameData = {
      potatoHolderId: randomStarter,
      passCount: 0
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
    if (message.action === "pass") {
      const p = state.players.get(client.sessionId);
      if (!p || !state.selectedPlayers.includes(client.sessionId)) return;

      const currentDataString = state.players.get(state.selectedPlayers[0])?.gameData || "{}";
      const gameData = JSON.parse(currentDataString);

      // Only the current holder can pass it natively
      if (gameData.potatoHolderId === client.sessionId) {
        // Find pool of other active players
        const others = state.selectedPlayers.toArray().filter(id => id !== client.sessionId);
        if (others.length > 0) {
           gameData.potatoHolderId = others[Math.floor(Math.random() * others.length)];
           gameData.passCount++;
           
           // Sync new potato holder instantly across the subset
           state.selectedPlayers.forEach(id => {
              const player = state.players.get(id);
              if (player) player.gameData = JSON.stringify(gameData);
           });
        }
      }
    }
  }

  onTick(state: LobbyState): void {}

  onEnd(state: LobbyState): void {
    let loserId: string | null = null;
    if (state.selectedPlayers.length > 0) {
       const gameData = JSON.parse(state.players.get(state.selectedPlayers[0])?.gameData || "{}");
       loserId = gameData.potatoHolderId || null;
    }

    state.lastWinners.clear();
    state.lastLosers.clear();

    const selectedArray = state.selectedPlayers.toArray();

    selectedArray.forEach((id, index) => {
      const p = state.players.get(id);
      if (p) {
        let isLoser = false;

        // If explicitly a 2v2 game with exactly 4 active players evaluated
        if (state.currentGameType === "2v2" && selectedArray.length === 4) {
          const loserIndex = selectedArray.indexOf(loserId as string);
          // Team mappings evaluate to exact halving of index splits precisely identically as initialization hooks
          const myTeam = index < 2 ? 0 : 1;
          const loserTeam = loserIndex < 2 ? 0 : 1;
          isLoser = (myTeam === loserTeam);
        } else {
          isLoser = (id === loserId);
        }

        if (isLoser) {
          p.drinks += 1;
          state.lastLosers.push(id);
        } else {
          p.score += 3;
          state.lastWinners.push(id);
        }
      }
    });

    const leaderboard = selectedArray.map(id => {
      const p = state.players.get(id);
      const isWinner = state.lastWinners.includes(id);
      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreLabel: isWinner ? "Survived" : "Blew Up 💥",
        isWinner
      };
    }).sort((a, b) => (a.isWinner === b.isWinner ? 0 : a.isWinner ? -1 : 1));

    state.lastGameResult = JSON.stringify({
      type: "elimination",
      title: "Potato Explosion",
      leaderboard
    });
  }
}
