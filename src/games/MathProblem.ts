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
  onInit(state: LobbyState): void {
    const puz = generateMathProblem();
    
    const gameData = {
      question: puz.question,
      options: puz.options,
      correct: puz.correct,
      winnerId: null as string | null,
      gameOver: false,
      wrongAnswers: [] as number[],
    };

    // Seed the identical localized puzzle to all clients efficiently
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0; // Tracker flags: 0 = solving, 1 = correct winner, -1 = definitively incorrect
        p.gameData = JSON.stringify(gameData);
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "answer") {
      const p = state.players.get(client.sessionId);
      if (!p || !state.selectedPlayers.includes(client.sessionId)) return;

      const pData = JSON.parse(p.gameData || "{}");
      if (pData.gameOver) return;
      if (pData.wrongAnswers && pData.wrongAnswers.includes(message.answer)) return;

      if (message.answer === pData.correct) {
        p.gameScore += 1;

        if (p.gameScore >= 3) {
          pData.winnerId = client.sessionId;
          pData.gameOver = true;
          
          state.selectedPlayers.forEach(id => {
             const player = state.players.get(id);
             if (player) {
                const lp = JSON.parse(player.gameData);
                lp.winnerId = client.sessionId;
                lp.gameOver = true;
                player.gameData = JSON.stringify(lp);
             }
          });
          state.timer = 1;

        } else {
          // Player advanced, generate new puzzle for everyone flawlessly syncing state
          const puz = generateMathProblem();
          
          state.selectedPlayers.forEach(id => {
             const player = state.players.get(id);
             if (player) {
                const lp = JSON.parse(player.gameData);
                lp.question = puz.question;
                lp.options = puz.options;
                lp.correct = puz.correct;
                lp.wrongAnswers = [];
                player.gameData = JSON.stringify(lp);
             }
          });
        }
      } else {
        // Punish player locally immediately
        pData.wrongAnswers = pData.wrongAnswers || [];
        pData.wrongAnswers.push(message.answer);
        p.gameData = JSON.stringify(pData);
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
        if (winners.includes(id)) {
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
