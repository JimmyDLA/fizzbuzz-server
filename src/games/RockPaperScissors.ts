import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class RockPaperScissors implements IMiniGame {
  private picks: Map<string, string> = new Map();
  private roundScores: Map<string, number> = new Map();
  private animationStartTime: number = 0;
  private revealTime: number = 0;
  private isEnded: boolean = false;

  onInit(state: LobbyState): void {
    this.picks.clear();
    this.roundScores.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.isEnded = false;

    const gameData = {
      choices: ["rock", "paper", "scissors"],
      picks: {}, // Visible status only (true/false)
      animationWord: "",
      reveal: false,
      results: {}, // hidden until reveal
      scores: {} // round wins scores
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
          const p1Id = ids[0];
          const p2Id = ids[1];
          const p1 = this.picks.get(p1Id);
          const p2 = this.picks.get(p2Id);

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
          } else if (p1 !== undefined && p2 !== undefined) {
             // Winner decided for the round!
             const p1Wins = (p1 === "rock" && p2 === "scissors") ||
                            (p1 === "paper" && p2 === "rock") ||
                            (p1 === "scissors" && p2 === "paper");
             const roundWinnerId = p1Wins ? p1Id : p2Id;
             const roundWinnerName = state.players.get(roundWinnerId)?.name || "Winner";

             const currentScore = this.roundScores.get(roundWinnerId) || 0;
             const newScore = currentScore + 1;
             this.roundScores.set(roundWinnerId, newScore);

             const scoresObj: any = {};
             ids.forEach(id => {
               scoresObj[id] = this.roundScores.get(id) || 0;
             });

             if (newScore >= 2) {
               // Match won!
               this.isEnded = true;
               this.broadcast(state, {
                 scores: scoresObj,
                 animationWord: `${roundWinnerName} WINS MATCH!`
               });

               setTimeout(() => {
                 state.timer = 0; // Trigger onEnd
               }, 2000);
             } else {
               // Next round!
               this.picks.clear();
               this.animationStartTime = 0;
               this.revealTime = 0;
               this.tieResetTime = Date.now();
               this.broadcast(state, {
                 picks: {},
                 scores: scoresObj,
                 animationWord: `${roundWinnerName} WINS ROUND!`,
                 reveal: false,
                 results: {}
               });
             }
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
    const score1 = this.roundScores.get(p1Id) || 0;
    const score2 = this.roundScores.get(p2Id) || 0;

    state.lastWinners.clear();
    state.lastLosers.clear();

    if (score1 > score2) {
      state.lastWinners.push(p1Id);
      state.lastLosers.push(p2Id);
    } else if (score2 > score1) {
      state.lastWinners.push(p2Id);
      state.lastLosers.push(p1Id);
    }

    state.lastWinners.forEach(id => {
      const p = state.players.get(id);
      if (p) p.score += 3;
    });
    state.lastLosers.forEach(id => {
      const p = state.players.get(id);
      if (p) p.drinks += 1;
    });

    const leaderboard = ids.map(id => {
      const p = state.players.get(id);
      const isWinner = state.lastWinners.includes(id);
      const isLoser = state.lastLosers.includes(id);
      const scoreVal = this.roundScores.get(id) || 0;
      
      let label = isWinner ? "Winner! 👑" : isLoser ? "Defeated 💀" : "Tied 🤝";

      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreLabel: `${label} (${scoreVal} Wins)`,
        isWinner
      };
    }).sort((a, b) => (a.isWinner === b.isWinner ? 0 : a.isWinner ? -1 : 1));

    state.lastGameResult = JSON.stringify({
      type: "elimination",
      title: "RPS Results",
      leaderboard
    });
  }
}
