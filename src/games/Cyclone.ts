import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

const NUM_LIGHTS = 50;
const TARGET_INDEX = 0;

export class Cyclone implements IMiniGame {
  private stoppedPlayers: Map<string, number> = new Map();
  private numPlayers = 0;

  onInit(state: LobbyState): void {
    this.stoppedPlayers.clear();
    this.numPlayers = state.selectedPlayers.length;

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify({ stoppedIndex: null });
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "stop") {
      if (!this.stoppedPlayers.has(client.sessionId)) {
        let index = message.index;
        // Keep it safe
        if (typeof index !== 'number') index = 25;
        index = Math.abs(Math.floor(index)) % NUM_LIGHTS;

        this.stoppedPlayers.set(client.sessionId, index);

        const p = state.players.get(client.sessionId);
        if (p) {
          p.gameData = JSON.stringify({ stoppedIndex: index });
        }

        // Check if all players have stopped
        if (this.stoppedPlayers.size === this.numPlayers) {
          state.timer = 1; // Instant transition to end
        }
      }
    }
  }

  onTick(state: LobbyState): void {
    // No specific tick logic needed
  }

  onEnd(state: LobbyState): void {
    state.lastWinners.clear();
    state.lastLosers.clear();

    const distances: { id: string, distance: number, index: number }[] = [];

    state.selectedPlayers.forEach(id => {
      if (this.stoppedPlayers.has(id)) {
        const stoppedIdx = this.stoppedPlayers.get(id)!;
        // Circular distance formula
        let dist = Math.abs(stoppedIdx - TARGET_INDEX);
        dist = Math.min(dist, NUM_LIGHTS - dist);
        distances.push({ id, distance: dist, index: stoppedIdx });
      } else {
        // Did not lock in within the time limit
        distances.push({ id, distance: 999, index: -1 });
      }
    });

    distances.sort((a, b) => a.distance - b.distance);

    const is2v2 = state.currentGameType === "2v2" && state.selectedPlayers.length === 4;
    const ids = state.selectedPlayers.toArray();

    const getDist = (id: string) => distances.find(d => d.id === id)?.distance ?? 999;
    const t1Score = is2v2 ? getDist(ids[0]) + getDist(ids[1]) : 0;
    const t2Score = is2v2 ? getDist(ids[2]) + getDist(ids[3]) : 0;

    if (distances.length > 0) {
      if (is2v2) {
        let winners: string[] = [];
        let losers: string[] = [];
        
        if (t1Score < 1998 || t2Score < 1998) {
          if (t1Score <= t2Score) winners.push(ids[0], ids[1]);
          else losers.push(ids[0], ids[1]);
          
          if (t2Score <= t1Score) winners.push(ids[2], ids[3]);
          else losers.push(ids[2], ids[3]);
        } else {
          losers.push(...ids);
        }

        winners.forEach(id => {
          state.lastWinners.push(id);
          const p = state.players.get(id);
          if (p) p.score += 3;
        });

        losers.forEach(id => {
          state.lastLosers.push(id);
          const p = state.players.get(id);
          if (p) p.drinks += 1;
        });
      } else {
        const bestDist = distances[0].distance;
        const winners = bestDist === 999 ? [] : distances.filter(d => d.distance === bestDist);
        const losers = bestDist === 999 ? distances : distances.filter(d => d.distance !== bestDist);

        winners.forEach(w => {
          state.lastWinners.push(w.id);
          const p = state.players.get(w.id);
          if (p) p.score += 3;
        });

        losers.forEach(l => {
          state.lastLosers.push(l.id);
          const p = state.players.get(l.id);
          if (p) p.drinks += 1;
        });
      }
    }

    // Attach results locally so the UI can draw exactly who won and how close everyone was
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        let prev = {};
        try { prev = JSON.parse(p.gameData); } catch (e) { }
        p.gameData = JSON.stringify({
          ...prev,
          finished: true,
          results: distances
        });
      }
    });

    const leaderboard = distances.map(d => {
      const p = state.players.get(d.id);
      let scoreLabel = d.distance === 999 ? "Timeout" : d.distance === 0 ? "BULLSEYE! 🎯" : `Missed by ${d.distance}`;
      let scoreValue = d.distance;

      if (is2v2) {
        const isTeam1 = d.id === ids[0] || d.id === ids[1];
        const teamScore = isTeam1 ? t1Score : t2Score;
        scoreValue = teamScore;
        const indLabel = d.distance === 999 ? "Timeout" : d.distance === 0 ? "BULLSEYE! 🎯" : `Missed by ${d.distance}`;
        
        if (teamScore >= 1998) {
          scoreLabel = `Team Timeout (${indLabel} ind.)`;
        } else if (teamScore === 0) {
          scoreLabel = `TEAM BULLSEYE! 🎯 (${indLabel} ind.)`;
        } else {
          scoreLabel = `Missed by ${teamScore} total (${indLabel} ind.)`;
        }
      }

      return {
        playerId: d.id,
        playerName: p?.name || "Unknown",
        scoreValue: -scoreValue, // Lower distance is better, so negate it for sorting
        scoreLabel,
        isWinner: state.lastWinners.includes(d.id)
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Cyclone Precision",
      leaderboard
    });
  }
}
