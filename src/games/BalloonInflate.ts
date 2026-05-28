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

    const is2v2 = state.currentGameType === "2v2" && state.selectedPlayers.length === 4;
    const ids = state.selectedPlayers.toArray();

    if (this.winnerId) {
      // Early burst win
      if (is2v2) {
        const isTeam1 = this.winnerId === ids[0] || this.winnerId === ids[1];
        const winners = isTeam1 ? [ids[0], ids[1]] : [ids[2], ids[3]];
        const losers = isTeam1 ? [ids[2], ids[3]] : [ids[0], ids[1]];

        winners.forEach(w => {
          state.lastWinners.push(w);
          timeoutWinners.push(w);
          const p = state.players.get(w);
          if (p) p.score += 3;
        });

        losers.forEach(l => {
          state.lastLosers.push(l);
          const p = state.players.get(l);
          if (p) p.drinks += 1;
        });
      } else {
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
      }
    } else {
      // Timeout win logic (biggest sizes win)
      if (is2v2) {
        const getSize = (id: string) => results.find(r => r.id === id)?.size || 0;
        const t1Score = getSize(ids[0]) + getSize(ids[1]);
        const t2Score = getSize(ids[2]) + getSize(ids[3]);

        if (t1Score > 0 || t2Score > 0) {
          const winners = t1Score > t2Score ? [ids[0], ids[1]] : t2Score > t1Score ? [ids[2], ids[3]] : [...ids];
          const losers = t1Score > t2Score ? [ids[2], ids[3]] : t2Score > t1Score ? [ids[0], ids[1]] : [];

          winners.forEach(w => {
            state.lastWinners.push(w);
            timeoutWinners.push(w);
            const p = state.players.get(w);
            if (p) p.score += 3;
          });

          losers.forEach(l => {
            state.lastLosers.push(l);
            const p = state.players.get(l);
            if (p) p.drinks += 1;
          });
        } else {
          // Nobody pumped
          ids.forEach(l => {
            state.lastLosers.push(l);
            const p = state.players.get(l);
            if (p) p.drinks += 1;
          });
        }
      } else {
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

    const leaderboard = results.map(r => {
      const p = state.players.get(r.id);
      const isWinner = state.lastWinners.includes(r.id);
      let scoreValue = r.size;
      let scoreLabel = r.size >= 100 ? "POPPED 💥" : `${r.size}%`;

      if (is2v2) {
        const isTeam1 = r.id === ids[0] || r.id === ids[1];
        const getSize = (id: string) => results.find(res => res.id === id)?.size || 0;
        const teamScore = isTeam1 ? getSize(ids[0]) + getSize(ids[1]) : getSize(ids[2]) + getSize(ids[3]);
        scoreValue = teamScore;
        const indLabel = r.size >= 100 ? "POPPED 💥" : `${r.size}%`;
        scoreLabel = teamScore >= 100 ? "POPPED 💥" : `${teamScore}% Team Total (${indLabel} ind.)`;
      }

      return {
        playerId: r.id,
        playerName: p?.name || "Unknown",
        scoreValue,
        scoreLabel,
        isWinner
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Balloon Sizes",
      leaderboard
    });
  }
}
