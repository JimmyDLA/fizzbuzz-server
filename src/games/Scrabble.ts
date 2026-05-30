import { Client } from "@colyseus/core";
import { IMiniGame } from "./IMiniGame";
import { LobbyState } from "../rooms/schema/LobbyState";
import englishWords from 'an-array-of-english-words';

// Initialize Dictionary in memory once for instant local validation
const DICTIONARY = new Set(englishWords.map(w => w.toUpperCase()));
const FIVE_LETTER_WORDS = englishWords.filter(w => w.length === 5).map(w => w.toUpperCase());

export class Scrabble implements IMiniGame {
  onInit(state: LobbyState): void {
    const activePlayers = state.selectedPlayers.toArray();
    
    // Pick a guaranteed valid 5-letter word
    const baseWord = FIVE_LETTER_WORDS[Math.floor(Math.random() * FIVE_LETTER_WORDS.length)];
    // Scramble the letters
    const letters = baseWord.split('').sort(() => Math.random() - 0.5);

    const gameData = {
      letters, // e.g. ["A", "P", "P", "L", "E"]
      foundWords: {} as Record<string, string[]>, // playerId -> ["PAL", "LAP", "APPLE"]
    };

    activePlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) {
        p.gameScore = 0; // Initialize score
        gameData.foundWords[id] = [];
        p.gameData = JSON.stringify(gameData);
      }
    });
  }

  onMessage(client: Client, message: any, state: LobbyState): void {
    if (message.action === "submit_word") {
      const id = client.sessionId;
      const word = (message.word || "").toUpperCase();

      const firstPlayer = state.players.get(state.selectedPlayers[0]);
      if (!firstPlayer) return;

      let gameData: any;
      try { gameData = JSON.parse(firstPlayer.gameData); } catch (e) { return; }

      // Validate the word
      let isValid = false;
      let isDuplicate = false;
      
      const playerFoundWords = gameData.foundWords[id] || [];

      // Ensure length is >= 2
      if (word.length >= 2) {
        // Ensure the word hasn't been submitted yet
        if (playerFoundWords.includes(word)) {
          isDuplicate = true;
        } else {
          // Ensure it can actually be formed by the given letters
          if (this.canFormWord(word, gameData.letters)) {
            // Check dictionary
            if (DICTIONARY.has(word)) {
              isValid = true;
            }
          }
        }
      }

      if (isValid) {
        playerFoundWords.push(word);
        gameData.foundWords[id] = playerFoundWords;

        // Add points based on length
        const p = state.players.get(id);
        if (p) p.gameScore += word.length;

        this.syncGameData(state, gameData);
      }

      // Send immediate UI feedback
      client.send("word_feedback", { word, isValid, isDuplicate });
    }
  }

  onTick(state: LobbyState): void {
    // Standard 30 second timer handled by the room. No custom ticking needed.
  }

  onEnd(state: LobbyState): void {
    const ids = state.selectedPlayers.toArray();
    const is2v2 = state.currentGameType === "2v2" && ids.length === 4;

    const getScore = (id: string) => state.players.get(id)?.gameScore || 0;
    
    let winners: string[] = [];
    
    if (is2v2) {
      const t1Score = getScore(ids[0]) + getScore(ids[1]);
      const t2Score = getScore(ids[2]) + getScore(ids[3]);
      if (t1Score > t2Score) winners = [ids[0], ids[1]];
      else if (t2Score > t1Score) winners = [ids[2], ids[3]];
      else winners = [...ids]; // Tie
    } else {
      let maxScore = -1;
      ids.forEach(id => {
        const score = getScore(id);
        if (score > maxScore) maxScore = score;
      });

      ids.forEach(id => {
        const score = getScore(id);
        if (score === maxScore && maxScore > 0) {
          winners.push(id);
        }
      });
    }

    // Award standard points
    state.lastWinners.clear();
    state.lastLosers.clear();

    winners.forEach(id => {
      const p = state.players.get(id);
      if (p) p.score += 3;
      state.lastWinners.push(id);
    });

    state.selectedPlayers.forEach(id => {
      if (!winners.includes(id)) {
        const p = state.players.get(id);
        if (p) p.drinks += 1;
        state.lastLosers.push(id);
      }
    });

    const leaderboard = ids.map(id => {
      const p = state.players.get(id);
      const isWinner = winners.includes(id);
      
      let teamScoreLabel = "";
      if (is2v2) {
        const isTeam1 = id === ids[0] || id === ids[1];
        const teamScore = isTeam1 ? getScore(ids[0]) + getScore(ids[1]) : getScore(ids[2]) + getScore(ids[3]);
        teamScoreLabel = ` (Team: ${teamScore})`;
      }

      return {
        playerId: id,
        playerName: p?.name || "Unknown",
        scoreValue: p?.gameScore || 0,
        scoreLabel: `${p?.gameScore || 0} Points${teamScoreLabel}`,
        isWinner
      };
    }).sort((a, b) => b.scoreValue - a.scoreValue);

    state.lastGameResult = JSON.stringify({
      type: "leaderboard",
      title: "Scrabble Results",
      leaderboard
    });
  }

  private canFormWord(word: string, availableLetters: string[]): boolean {
    const counts: Record<string, number> = {};
    for (const char of availableLetters) {
      counts[char] = (counts[char] || 0) + 1;
    }
    
    for (const char of word) {
      if (!counts[char] || counts[char] === 0) return false;
      counts[char]--;
    }
    return true;
  }

  private syncGameData(state: LobbyState, gameData: any) {
    const dataStr = JSON.stringify(gameData);
    state.selectedPlayers.forEach(id => {
      const p = state.players.get(id);
      if (p) p.gameData = dataStr;
    });
  }
}
