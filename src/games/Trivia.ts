import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

export class Trivia implements IMiniGame {
  private static questionPool: any[] = [];
  private static isFetchingPool: boolean = false;

  private currentBatch: any[] = [];
  private currentQuestionIndex: number = 0;
  private isTransitioning: boolean = false;

  static async ensurePool() {
    if (Trivia.isFetchingPool) return;
    Trivia.isFetchingPool = true;

    try {
      const response = await fetch("https://the-trivia-api.com/v2/questions");
      const data = await response.json();
      if (Array.isArray(data)) {
        Trivia.questionPool.push(...data);
      }
    } catch (error) {
      console.error("Failed to fetch trivia questions:", error);
      if (Trivia.questionPool.length === 0) {
        Trivia.questionPool.push({
          question: { text: "What is the capital of France?" },
          correctAnswer: "Paris",
          incorrectAnswers: ["London", "Berlin", "Rome"]
        });
      }
    } finally {
      Trivia.isFetchingPool = false;
    }
  }

  onInit(state: LobbyState): void {
    this.initializeGame(state);
  }

  private async initializeGame(state: LobbyState) {
    if (Trivia.questionPool.length < 3) {
      await Trivia.ensurePool();
    }
    
    this.currentBatch = Trivia.questionPool.splice(0, 3);
    
    if (Trivia.questionPool.length <= 1) {
       Trivia.ensurePool(); 
    }

    this.currentQuestionIndex = 0;
    this.broadcastState(state);
  }

  private broadcastState(state: LobbyState) {
    if (!this.currentBatch || this.currentBatch.length === 0) return;

    const q = this.currentBatch[this.currentQuestionIndex];
    if (!q) return;

    const gameData = {
      question: q.question.text,
      options: this.shuffle([...q.incorrectAnswers, q.correctAnswer]),
      correctAnswer: q.correctAnswer,
      index: this.currentQuestionIndex,
      total: this.currentBatch.length,
      answeredCorrectly: false,
      isTransitioning: false
    };

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameData = JSON.stringify(gameData);
      }
    });
  }

  private broadcastTransitionState(state: LobbyState, winnerName: string, correctAnswer: string) {
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        let oldData: any = {};
        try { oldData = JSON.parse(p.gameData || "{}"); } catch (e) {}
        p.gameData = JSON.stringify({
          ...oldData,
          isTransitioning: true,
          roundWinner: winnerName,
          correctAnswer: correctAnswer
        });
      }
    });
  }

  private shuffle(array: any[]) {
    const newArr = [...array];
    for (let i = newArr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
    }
    return newArr;
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "answer") {
      if (this.isTransitioning) return;

      const player = state.players.get(client.sessionId);
      if (!player || !state.selectedPlayers.includes(client.sessionId)) return;

      const q = this.currentBatch[this.currentQuestionIndex];
      if (!q) return;

      if (message.answer === q.correctAnswer) {
        player.gameScore += 1;
        this.isTransitioning = true;
        this.broadcastTransitionState(state, player.name, q.correctAnswer);

        setTimeout(() => {
          this.isTransitioning = false;
          this.currentQuestionIndex++;
          
          if (this.currentQuestionIndex >= this.currentBatch.length) {
            state.timer = 0; // Force end the game loop immediately
          } else {
            this.broadcastState(state);
          }
        }, 2000);
      } else {
        // Feedback for wrong answer could be handled client-side
        // or we could mark the player's gameData with "wrong"
      }
    }
  }

  onTick(state: LobbyState): void {}

  onEnd(state: LobbyState): void {
    let maxScore = -1;
    let winners: string[] = [];

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        if (p.gameScore > maxScore) {
          maxScore = p.gameScore;
          winners = [id];
        } else if (p.gameScore === maxScore) {
          winners.push(id);
        }
      }
    });

    state.lastWinners.clear();
    state.lastLosers.clear();

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        if (winners.length > 0 && winners.includes(id) && maxScore > 0) {
          p.score += 3;
          state.lastWinners.push(id);
        } else {
          p.drinks += 1;
          state.lastLosers.push(id);
        }
      }
    });
  }
}
