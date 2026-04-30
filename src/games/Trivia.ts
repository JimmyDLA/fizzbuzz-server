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
      isTransitioning: false,
      isLockedOut: false
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
        try { oldData = JSON.parse(p.gameData || "{}"); } catch (e) { }
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

      let oldData: any = {};
      try { oldData = JSON.parse(player.gameData || "{}"); } catch (e) { }
      if (oldData.isLockedOut) return;

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
        }, 3000);
      } else {
        // Punish player for wrong answer by locking them out of the current question
        player.gameData = JSON.stringify({
          ...oldData,
          isLockedOut: true
        });

        // Check if ALL selected players are now locked out
        let allLockedOut = true;
        state.selectedPlayers.forEach(id => {
          const sp = state.players.get(id);
          if (sp) {
            let spData: any = {};
            try { spData = JSON.parse(sp.gameData || "{}"); } catch (e) { }
            if (!spData.isLockedOut) {
              allLockedOut = false;
            }
          }
        });

        if (allLockedOut) {
          // Everyone got it wrong! Skip to the next question immediately
          this.currentQuestionIndex++;
          if (this.currentQuestionIndex >= this.currentBatch.length) {
            state.timer = 0; // Force end the game loop immediately
          } else {
            this.broadcastState(state);
          }
        }
      }
    }
  }

  onTick(state: LobbyState): void { }

  onEnd(state: LobbyState): void {
    let winners: string[] = [];
    const ids = state.selectedPlayers.toArray();

    if (state.currentGameType === "2v2" && ids.length === 4) {
      const t1Score = (state.players.get(ids[0])?.gameScore || 0) + (state.players.get(ids[1])?.gameScore || 0);
      const t2Score = (state.players.get(ids[2])?.gameScore || 0) + (state.players.get(ids[3])?.gameScore || 0);

      if (t1Score >= t2Score && t1Score > 0) winners.push(ids[0], ids[1]);
      if (t2Score >= t1Score && t2Score > 0) winners.push(ids[2], ids[3]);
    } else {
      let maxScore = -1;
      ids.forEach(id => {
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
      // Winners only count if score > 0
      if (maxScore <= 0) winners = [];
    }

    state.lastWinners.clear();
    state.lastLosers.clear();

    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        if (winners.length > 0 && winners.includes(id)) {
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
