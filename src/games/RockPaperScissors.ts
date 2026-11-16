import { Client } from "@colyseus/core";
import { emptyGameResult, GameResult, IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

/**
 * How long a sudden-death throw stays open before a missing pick is resolved.
 * This is not a match cap. A throw nobody locked is replayed, and play
 * continues until one player wins a throw.
 */
export const SUDDEN_DEATH_PICK_MS = 10000;

const TIE_RESET_MS = 2000;
const REVEAL_MS = 2000;

/**
 * Best of 3 during the room timer. A tied throw replays with no score.
 * If time runs out on a level score, sudden death replays throws until one
 * player wins. That winner gets +3 and the other drinks, once, via LobbyRoom.
 * This game does not write score or drinks.
 */
export class RockPaperScissors implements IMiniGame {
  private picks: Map<string, string> = new Map();
  private roundScores: Map<string, number> = new Map();
  private animationStartTime: number = 0;
  private revealTime: number = 0;
  private tieResetTime: number = 0;
  private pickDeadline: number = 0;
  private isEnded: boolean = false;
  private suddenDeath: boolean = false;
  /** Latched when the room clock passes 0, so later timer holds do not look like time is left. */
  private regulationExpired: boolean = false;

  onInit(state: LobbyState): void {
    this.picks.clear();
    this.roundScores.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.tieResetTime = 0;
    this.pickDeadline = 0;
    this.isEnded = false;
    this.suddenDeath = false;
    this.regulationExpired = false;

    const gameData = {
      choices: ["rock", "paper", "scissors"],
      picks: {},
      animationWord: "",
      reveal: false,
      results: {},
      scores: {},
      gameOver: false,
      suddenDeath: false
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
    if (this.isEnded) return;
    if (message.action !== "pick") return;
    if (this.picks.has(client.sessionId)) return;
    if (this.animationStartTime > 0) return;
    if (typeof message.choice !== "string") return;

    this.picks.set(client.sessionId, message.choice.toLowerCase());

    const picksStatus: any = {};
    this.picks.forEach((_, id) => picksStatus[id] = true);
    this.broadcast(state, { picks: picksStatus });

    const pair = this.contestants(state);
    if (pair && this.picks.has(pair[0]) && this.picks.has(pair[1])) {
      this.animationStartTime = Date.now();
      this.pickDeadline = 0;
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

  onTick(state: LobbyState): void {
    if (this.isEnded) return;
    if (state.timer < 0) this.regulationExpired = true;
    this.holdClock(state);

    if (this.tieResetTime > 0) {
      if (Date.now() - this.tieResetTime > TIE_RESET_MS) {
        this.tieResetTime = 0;
        this.broadcast(state, { animationWord: "" });
        this.afterBanner(state);
      }
      return;
    }

    if (this.animationStartTime > 0) {
      this.tickAnimation(state);
      return;
    }

    if (this.suddenDeath) {
      if (this.pickDeadline > 0 && Date.now() >= this.pickDeadline) {
        this.resolveOpenThrow(state);
      }
      return;
    }

    if (this.regulationExpired) {
      this.onRegulationExpired(state);
    }
  }

  /**
   * Keep LobbyRoom from scoring a tied match. The room ends the game once
   * `timer < -1`. A level RPS match holds the clock and keeps throwing.
   */
  private holdClock(state: LobbyState): void {
    if (this.isEnded) return;
    const throwBusy = this.animationStartTime > 0 || this.tieResetTime > 0;
    const keepOpen = this.suddenDeath || (this.regulationExpired && throwBusy);
    if (keepOpen && state.timer < 1) state.timer = 1;
  }

  private afterBanner(state: LobbyState): void {
    if (this.suddenDeath) {
      this.openSuddenDeathWindow();
      return;
    }
    if (!this.regulationExpired) return;
    const leader = this.leaderId(state);
    if (leader) this.endMatch(state, leader);
    else this.enterSuddenDeath(state);
  }

  private tickAnimation(state: LobbyState): void {
    const elapsed = Date.now() - this.animationStartTime;

    let word = "";
    if (elapsed < 800) word = "ROCK...";
    else if (elapsed < 1600) word = "PAPER...";
    else if (elapsed < 2400) word = "SCISSORS...";
    else if (elapsed < 3200) word = "SHOOT!";
    else {
      if (this.revealTime === 0) {
        this.revealTime = Date.now();
        const results: any = {};
        this.picks.forEach((choice, id) => results[id] = choice);
        this.broadcast(state, { reveal: true, results, animationWord: "SHOOT!" });
      }

      if (Date.now() - this.revealTime > REVEAL_MS) {
        this.resolveLockedThrow(state);
      }
      return;
    }

    this.broadcast(state, { animationWord: word });
  }

  private resolveLockedThrow(state: LobbyState): void {
    const pair = this.contestants(state);
    if (!pair) return;
    const [p1Id, p2Id] = pair;
    const p1 = this.picks.get(p1Id);
    const p2 = this.picks.get(p2Id);

    if (p1 !== undefined && p2 !== undefined && p1 === p2) {
      this.beginReplay(state, "TIE! TRY AGAIN...");
      return;
    }

    if (p1 !== undefined && p2 !== undefined) {
      const p1Wins = (p1 === "rock" && p2 === "scissors") ||
                     (p1 === "paper" && p2 === "rock") ||
                     (p1 === "scissors" && p2 === "paper");
      this.awardThrow(state, p1Wins ? p1Id : p2Id);
      return;
    }

    if ((p1 !== undefined) !== (p2 !== undefined)) {
      this.awardThrow(state, p1 !== undefined ? p1Id : p2Id);
    }
  }

  /**
   * Regulation time is up and no throw is mid-reveal.
   * One locked pick wins the throw. Nobody locked, and the score is level:
   * sudden death. A strict lead ends the match.
   */
  private onRegulationExpired(state: LobbyState): void {
    const pair = this.contestants(state);
    if (!pair) return;
    const [p1Id, p2Id] = pair;
    const p1In = this.picks.has(p1Id);
    const p2In = this.picks.has(p2Id);

    if (p1In !== p2In) {
      this.roundScores.set(p1In ? p1Id : p2Id, (this.roundScores.get(p1In ? p1Id : p2Id) || 0) + 1);
      this.picks.clear();
      this.pickDeadline = 0;
    }

    const leader = this.leaderId(state);
    if (leader) this.endMatch(state, leader);
    else this.enterSuddenDeath(state);
  }

  /** Sudden-death pick window closed before both contestants locked a choice. */
  private resolveOpenThrow(state: LobbyState): void {
    const pair = this.contestants(state);
    if (!pair) return;
    const [p1Id, p2Id] = pair;
    const p1In = this.picks.has(p1Id);
    const p2In = this.picks.has(p2Id);
    this.pickDeadline = 0;

    if (p1In && p2In) {
      this.animationStartTime = Date.now();
      this.revealTime = 0;
      return;
    }
    if (p1In !== p2In) {
      this.awardThrow(state, p1In ? p1Id : p2Id);
      return;
    }
    this.beginReplay(state, "NO PICK! TRY AGAIN...");
  }

  private awardThrow(state: LobbyState, winnerId: string): void {
    const newScore = (this.roundScores.get(winnerId) || 0) + 1;
    this.roundScores.set(winnerId, newScore);
    this.picks.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.pickDeadline = 0;

    const decided = this.suddenDeath || newScore >= 2 || (this.regulationExpired && this.leaderId(state) !== null);
    if (decided) {
      this.endMatch(state, winnerId);
      return;
    }
    if (this.regulationExpired) {
      this.enterSuddenDeath(state);
      return;
    }

    const name = state.players.get(winnerId)?.name || "Winner";
    this.tieResetTime = Date.now();
    this.broadcast(state, {
      picks: {},
      scores: this.scoreMap(state),
      animationWord: `${name} WINS ROUND!`,
      reveal: false,
      results: {}
    });
  }

  private beginReplay(state: LobbyState, word: string): void {
    this.picks.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.pickDeadline = 0;
    this.tieResetTime = Date.now();
    this.broadcast(state, {
      picks: {},
      animationWord: word,
      reveal: false,
      results: {}
    });
  }

  private enterSuddenDeath(state: LobbyState): void {
    if (this.isEnded) return;
    this.suddenDeath = true;
    this.picks.clear();
    this.animationStartTime = 0;
    this.revealTime = 0;
    this.pickDeadline = 0;
    this.tieResetTime = Date.now();
    if (state.timer < 1) state.timer = 1;
    this.broadcast(state, {
      picks: {},
      scores: this.scoreMap(state),
      animationWord: "SUDDEN DEATH!",
      reveal: false,
      results: {},
      suddenDeath: true,
      gameOver: false
    });
  }

  private openSuddenDeathWindow(): void {
    if (!this.suddenDeath || this.isEnded) return;
    this.pickDeadline = Date.now() + SUDDEN_DEATH_PICK_MS;
  }

  private endMatch(state: LobbyState, winnerId: string): void {
    this.isEnded = true;
    this.pickDeadline = 0;
    const name = state.players.get(winnerId)?.name || "Winner";
    this.broadcast(state, {
      scores: this.scoreMap(state),
      animationWord: `${name} WINS MATCH!`,
      suddenDeath: this.suddenDeath
    });
    if (state.timer < 0) state.timer = 0;

    setTimeout(() => {
      this.broadcast(state, {
        animationWord: "",
        reveal: false,
        gameOver: true
      });
      state.timer = 0;
    }, 2000);
  }

  private contestants(state: LobbyState): [string, string] | null {
    const ids = state.selectedPlayers.toArray();
    if (ids.length < 2) return null;
    if (!state.players.has(ids[0]) || !state.players.has(ids[1])) return null;
    return [ids[0], ids[1]];
  }

  private scoreMap(state: LobbyState): Record<string, number> {
    const scores: Record<string, number> = {};
    state.selectedPlayers.forEach(id => {
      scores[id] = this.roundScores.get(id) || 0;
    });
    return scores;
  }

  private leaderId(state: LobbyState): string | null {
    const pair = this.contestants(state);
    if (!pair) return null;
    const score1 = this.roundScores.get(pair[0]) || 0;
    const score2 = this.roundScores.get(pair[1]) || 0;
    if (score1 > score2 && score1 > 0) return pair[0];
    if (score2 > score1 && score2 > 0) return pair[1];
    return null;
  }

  onEnd(state: LobbyState): GameResult {
    const ids = state.selectedPlayers
      .toArray()
      .filter(id => state.players.has(id) && state.players.get(id)?.isConnected);
    if (ids.length < 2) return emptyGameResult();

    const p1Id = ids[0];
    const p2Id = ids[1];
    const score1 = this.roundScores.get(p1Id) || 0;
    const score2 = this.roundScores.get(p2Id) || 0;

    state.lastWinners.clear();
    state.lastLosers.clear();

    if (score1 > score2 && score1 > 0) {
      state.lastWinners.push(p1Id);
      state.lastLosers.push(p2Id);
    } else if (score2 > score1 && score2 > 0) {
      state.lastWinners.push(p2Id);
      state.lastLosers.push(p1Id);
    }
    // A level score is not a result. Sudden death replays until someone wins,
    // so this does not mark either player a loser and does not award a tie.

    const leaderboard = ids.map(id => {
      const p = state.players.get(id);
      const isWinner = state.lastWinners.includes(id);
      const isLoser = state.lastLosers.includes(id);
      const scoreVal = this.roundScores.get(id) || 0;
      const label = isWinner ? "Winner!" : isLoser ? "Defeated" : "Tied";

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

    return {
      winners: state.lastWinners.toArray(),
      losers: state.lastLosers.toArray(),
      tiedIds: [],
    };
  }
}
