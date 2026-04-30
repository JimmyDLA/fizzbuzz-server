import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

const TARGET_SIZE = 100;
const PUMP_AMOUNT = 4;
const DEFLATE_AMOUNT = 6;

export class BalloonInflate implements IMiniGame {
  private balloonSizes: Map<string, number> = new Map();
  private winnerId: string | null = null;
  private isEnded = false;

  onInit(state: LobbyState): void {
    this.balloonSizes.clear();
    this.winnerId = null;
    this.isEnded = false;

    state.selectedPlayers.forEach(id => {
      this.balloonSizes.set(id, 0);
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify({ size: 0, burst: false });
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (this.isEnded) return;

    if (message.action === "pump") {
      let currentSize = this.balloonSizes.get(client.sessionId) || 0;
      currentSize += PUMP_AMOUNT;

      if (currentSize >= TARGET_SIZE) {
        currentSize = TARGET_SIZE;
        this.winnerId = client.sessionId;
        this.isEnded = true;
        state.timer = 1; // Instant transition to end
      }

      this.balloonSizes.set(client.sessionId, currentSize);
      this.syncState(client.sessionId, state, currentSize, currentSize >= TARGET_SIZE);
    }
  }

  onTick(state: LobbyState): void {
    if (this.isEnded) return;

    state.selectedPlayers.forEach(id => {
      let size = this.balloonSizes.get(id) || 0;
      if (size > 0) {
        size -= DEFLATE_AMOUNT;
        if (size < 0) size = 0;
        this.balloonSizes.set(id, size);
        this.syncState(id, state, size, false);
      }
    });
  }

  private syncState(id: string, state: LobbyState, size: number, burst: boolean) {
    const p = state.players.get(id);
    if (p) {
      let prev = {};
      try { prev = JSON.parse(p.gameData); } catch (e) { }
      p.gameData = JSON.stringify({ ...prev, size, burst });
    }
  }

  onEnd(state: LobbyState): void {
    state.lastWinners.clear();
    state.lastLosers.clear();

    const results: { id: string, size: number }[] = [];

    state.selectedPlayers.forEach(id => {
      const size = this.balloonSizes.get(id) || 0;
      results.push({ id, size });
    });

    let timeoutWinners: string[] = [];

    if (this.winnerId) {
      // Early burst win
      state.lastWinners.push(this.winnerId);
      const p = state.players.get(this.winnerId);
      if (p) p.score += 3;

      results.forEach(l => {
        if (l.id !== this.winnerId) {
          state.lastLosers.push(l.id);
          const loserP = state.players.get(l.id);
          if (loserP) loserP.drinks += 1;
        }
      });
    } else {
      // Timeout win logic (biggest sizes win)
      results.sort((a, b) => b.size - a.size);
      const max = results[0].size;

      if (max > 0) {
        const winners = results.filter(r => r.size === max);
        const losers = results.filter(r => r.size !== max);

        winners.forEach(w => {
          state.lastWinners.push(w.id);
          timeoutWinners.push(w.id);
          const p = state.players.get(w.id);
          if (p) p.score += 3;
        });

        losers.forEach(l => {
          state.lastLosers.push(l.id);
          const p = state.players.get(l.id);
          if (p) p.drinks += 1;
        });
      } else {
        // Nobody pumped
        results.forEach(l => {
          state.lastLosers.push(l.id);
          const p = state.players.get(l.id);
          if (p) p.drinks += 1;
        });
      }
    }

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        let prev = {};
        try { prev = JSON.parse(p.gameData); } catch (e) { }
        p.gameData = JSON.stringify({
          ...prev,
          finished: true,
          winnerId: this.winnerId,
          timeoutWinners: timeoutWinners
        });
      }
    });
  }
}
