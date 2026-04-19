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

    if (distances.length > 0) {
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
  }
}
