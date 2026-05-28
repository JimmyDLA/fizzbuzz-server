import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";

const generateMathProblem = () => {
    const operators = ['+', '-', '×', '÷'];
    const op = operators[Math.floor(Math.random() * operators.length)];

    let a = 0, b = 0, correct = 0;
    let question = "";

    switch (op) {
      case '+':
        a = Math.floor(Math.random() * 40) + 10;
        b = Math.floor(Math.random() * 40) + 10;
        correct = a + b;
        question = `${a} + ${b}`;
        break;
      case '-':
        correct = Math.floor(Math.random() * 40) + 5;
        b = Math.floor(Math.random() * 40) + 5;
        a = correct + b;
        question = `${a} - ${b}`;
        break;
      case '×':
        a = Math.floor(Math.random() * 12) + 2; 
        b = Math.floor(Math.random() * 12) + 2;
        correct = a * b;
        question = `${a} × ${b}`;
        break;
      case '÷':
        correct = Math.floor(Math.random() * 12) + 2;
        b = Math.floor(Math.random() * 12) + 2;
        a = correct * b;
        question = `${a} ÷ ${b}`;
        break;
    }
    
    // Generate distinct option permutations
    const options = [correct];
    while(options.length < 4) {
      const variance = Math.floor(Math.random() * 30) - 15;
      const wrong = correct + (variance === 0 ? 1 : variance);
      if (!options.includes(wrong) && wrong >= 0) {
        options.push(wrong);
      }
    }

    // Scramble deterministic patterns
    options.sort(() => Math.random() - 0.5);

    return { question, options, correct };
};

export class MathProblem implements IMiniGame {
  private currentQuestionIndex: number = 0;
  private readonly maxQuestions = 3;
  private isTransitioning: boolean = false;
  private playerHistory = new Map<string, boolean[]>();

  onInit(state: LobbyState): void {
    this.currentQuestionIndex = 0;
    this.isTransitioning = false;
    const puz = generateMathProblem();
    
    const gameData = {
      question: puz.question,
      options: puz.options,
      correct: puz.correct,
      winnerId: null as string | null,
      gameOver: false,
      isLockedOut: false,
      isTransitioning: false,
      roundWinner: "",
      correctAnswer: puz.correct,
      index: this.currentQuestionIndex,
      wrongAnswers: [] as number[],
    };

    // Seed the identical localized puzzle to all clients efficiently
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0;
        p.gameData = JSON.stringify(gameData);
        this.playerHistory.set(id, []);
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "answer") {
      if (this.isTransitioning) return;

      const p = state.players.get(client.sessionId);
      if (!p || !state.selectedPlayers.includes(client.sessionId)) return;

      const pData = JSON.parse(p.gameData || "{}");
      if (pData.gameOver || pData.isLockedOut) return;
      if (pData.wrongAnswers && pData.wrongAnswers.includes(message.answer)) return;

      if (message.answer === pData.correct) {
        p.gameScore += 1;
        this.isTransitioning = true;

        this.playerHistory.get(client.sessionId)?.push(true);
        state.selectedPlayers.forEach(id => {
          if (id !== client.sessionId) {
            this.playerHistory.get(id)?.push(false);
          }
        });

        state.selectedPlayers.forEach(id => {
          const sp = state.players.get(id);
          if (sp) {
            const lp = JSON.parse(sp.gameData || "{}");
            lp.isTransitioning = true;
            lp.roundWinner = p.name;
            lp.correctAnswer = pData.correct;
            sp.gameData = JSON.stringify(lp);
          }
        });

        setTimeout(() => {
          this.isTransitioning = false;
          this.currentQuestionIndex++;

          if (this.currentQuestionIndex >= this.maxQuestions) {
            state.selectedPlayers.forEach(id => {
               const player = state.players.get(id);
               if (player) {
                  const lp = JSON.parse(player.gameData);
                  lp.winnerId = client.sessionId;
                  lp.gameOver = true;
                  lp.isTransitioning = false;
                  lp.index = this.currentQuestionIndex;
                  player.gameData = JSON.stringify(lp);
               }
            });
            state.timer = 1;
          } else {
            const puz = generateMathProblem();
            state.selectedPlayers.forEach(id => {
               const player = state.players.get(id);
               if (player) {
                  const lp = JSON.parse(player.gameData);
                  lp.question = puz.question;
                  lp.options = puz.options;
                  lp.correct = puz.correct;
                  lp.wrongAnswers = [];
                  lp.isLockedOut = false;
                  lp.isTransitioning = false;
                  lp.index = this.currentQuestionIndex;
                  player.gameData = JSON.stringify(lp);
               }
            });
          }
        }, 2500);

      } else {
        pData.wrongAnswers = pData.wrongAnswers || [];
        pData.wrongAnswers.push(message.answer);
        pData.isLockedOut = true;
        p.gameData = JSON.stringify(pData);

        let allLockedOut = true;
        state.selectedPlayers.forEach(id => {
          const sp = state.players.get(id);
          if (sp) {
            let spData: any = {};
            try { spData = JSON.parse(sp.gameData || "{}"); } catch(e) {}
            if (!spData.isLockedOut) {
              allLockedOut = false;
            }
          }
        });

        if (allLockedOut) {
          this.isTransitioning = true;
          
          state.selectedPlayers.forEach(id => {
            this.playerHistory.get(id)?.push(false);
          });

          state.selectedPlayers.forEach(id => {
            const sp = state.players.get(id);
            if (sp) {
              const lp = JSON.parse(sp.gameData || "{}");
              lp.isTransitioning = true;
              lp.roundWinner = "Nobody";
              lp.correctAnswer = pData.correct;
              sp.gameData = JSON.stringify(lp);
            }
          });

          setTimeout(() => {
            this.isTransitioning = false;
            this.currentQuestionIndex++;
            
            if (this.currentQuestionIndex >= this.maxQuestions) {
              state.selectedPlayers.forEach(id => {
                 const player = state.players.get(id);
                 if (player) {
                    const lp = JSON.parse(player.gameData);
                    lp.gameOver = true;
                    lp.isTransitioning = false;
                    lp.index = this.currentQuestionIndex;
                    player.gameData = JSON.stringify(lp);
                 }
              });
              state.timer = 1;
            } else {
              const puz = generateMathProblem();
              state.selectedPlayers.forEach(id => {
                 const player = state.players.get(id);
                 if (player) {
                    const lp = JSON.parse(player.gameData);
                    lp.question = puz.question;
                    lp.options = puz.options;
                    lp.correct = puz.correct;
                    lp.wrongAnswers = [];
                    lp.isLockedOut = false;
                    lp.isTransitioning = false;
                    lp.index = this.currentQuestionIndex;
                    player.gameData = JSON.stringify(lp);
                 }
              });
            }
          }, 2500);
        }
      }
    }
  }

  onTick(state: LobbyState): void {}

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
        if (winners.includes(id)) {
          p.score += 3;
          state.lastWinners.push(id);
        } else {
          p.drinks += 1;
          state.lastLosers.push(id);
        }
      }
    });

    const is2v2 = state.currentGameType === "2v2" && ids.length === 4;
    const t1Score = is2v2 ? (state.players.get(ids[0])?.gameScore || 0) + (state.players.get(ids[1])?.gameScore || 0) : 0;
    const t2Score = is2v2 ? (state.players.get(ids[2])?.gameScore || 0) + (state.players.get(ids[3])?.gameScore || 0) : 0;

    const timeline = ids.map(id => {
      const p = state.players.get(id);
      const history = this.playerHistory.get(id) || [];
      
      let scoreValue = p?.gameScore || 0;
      let scoreLabel = `${scoreValue} Points`;

      if (is2v2) {
        const isTeam1 = id === ids[0] || id === ids[1];
        const teamScore = isTeam1 ? t1Score : t2Score;
        scoreValue = teamScore;
        scoreLabel = `${teamScore} Team Points (${p?.gameScore || 0} Individually)`;
      }

      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue,
        scoreLabel,
        isWinner: winners.includes(id),
        events: history.map((success, idx) => ({
          label: `Q${idx + 1}`,
          success
        }))
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "timeline",
      title: "Math Breakdown",
      timeline
    });
  }
}
