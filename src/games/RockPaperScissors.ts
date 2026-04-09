import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class RockPaperScissors implements IMiniGame {
  private picks: Map<string, string> = new Map();
  private animationStartTime: number = 0;
  private revealTime: number = 0;
  private isEnded: boolean = false;

  onInit(state: LobbyState): void {
    this.picks.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.isEnded = false;

    const gameData = {
      choices: ["rock", "paper", "scissors"],
      picks: {}, // Visible status only (true/false)
      animationWord: "",
      reveal: false,
      results: {} // hidden until reveal
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
    if (message.action === "pick") {
      if (this.picks.has(client.sessionId)) return;
      if (this.animationStartTime > 0) return; // Locked once animation starts

      this.picks.set(client.sessionId, message.choice.toLowerCase());

      // Update public "who has picked" status
      const picksStatus: any = {};
      this.picks.forEach((_, id) => picksStatus[id] = true);

      this.broadcast(state, { picks: picksStatus });

      if (this.picks.size >= 2) {
        this.animationStartTime = Date.now();
      }
    }
  }

  private broadcast(state: LobbyState, update: any) {
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        const current = JSON.parse(p.gameData || "{}");
        p.gameData = JSON.stringify({ ...current, ...update });
      }
    });
  }

  private tieResetTime: number = 0;

  onTick(state: LobbyState): void {
    if (this.tieResetTime > 0) {
      if (Date.now() - this.tieResetTime > 2000) {
        this.tieResetTime = 0;
        this.broadcast(state, { animationWord: "" });
      }
      return;
    }

    if (this.animationStartTime > 0 && !this.isEnded) {
      const elapsed = Date.now() - this.animationStartTime;

      let word = "";
      if (elapsed < 800) word = "ROCK...";
      else if (elapsed < 1600) word = "PAPER...";
      else if (elapsed < 2400) word = "SCISSORS...";
      else if (elapsed < 3200) word = "SHOOT!";
      else {
        // Reveal!
        if (this.revealTime === 0) {
          this.revealTime = Date.now();
          const results: any = {};
          this.picks.forEach((choice, id) => results[id] = choice);
          this.broadcast(state, { reveal: true, results, animationWord: "SHOOT!" });
        }
        
        // Handle resolution
        if (Date.now() - this.revealTime > 2000) {
          const ids = state.selectedPlayers.toArray();
          const p1 = this.picks.get(ids[0]);
          const p2 = this.picks.get(ids[1]);

          if (p1 === p2 && p1 !== undefined) {
             // Tie! Reset for a do-over
             this.picks.clear();
             this.animationStartTime = 0;
             this.revealTime = 0;
             this.tieResetTime = Date.now();
             this.broadcast(state, {
                picks: {},
                animationWord: "TIE! TRY AGAIN...",
                reveal: false,
                results: {}
             });
          } else {
             // Winner decided!
             this.isEnded = true;
             state.timer = 0; // Trigger onEnd
          }
        }
        return;
      }

      this.broadcast(state, { animationWord: word });
    }
  }

  onEnd(state: LobbyState): void {
    const ids = state.selectedPlayers.toArray();
    if (ids.length < 2) return;

    const p1Id = ids[0];
    const p2Id = ids[1];
    const pick1 = this.picks.get(p1Id);
    const pick2 = this.picks.get(p2Id);

    state.lastWinners.clear();
    state.lastLosers.clear();

    if (!pick1 || !pick2) {
        // Someone didn't pick in time? (shouldn't happen with our logic but for safety)
        if (pick1) state.lastWinners.push(p1Id);
        else if (pick2) state.lastWinners.push(p2Id);
    } else if (pick1 === pick2) {
      // Tie at the end of the full timer (60s) should result in no winners
      // (This is a fallback since onTick handles mid-game ties)
    } else {
      const p1Wins = (pick1 === "rock" && pick2 === "scissors") ||
                     (pick1 === "paper" && pick2 === "rock") ||
                     (pick1 === "scissors" && pick2 === "paper");

      if (p1Wins) {
        state.lastWinners.push(p1Id);
        state.lastLosers.push(p2Id);
      } else {
        state.lastWinners.push(p2Id);
        state.lastLosers.push(p1Id);
      }
    }

    state.lastWinners.forEach(id => {
      const p = state.players.get(id);
      if (p) p.score += 3;
    });
    state.lastLosers.forEach(id => {
      const p = state.players.get(id);
      if (p) p.drinks += 1;
    });
  }
}
