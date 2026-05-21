import { Room, Client, ServerError } from "@colyseus/core";
import { LobbyState, Player } from "./schema/LobbyState";
import { IMiniGame } from "../games/IMiniGame";
import { TappingRace } from "../games/TappingRace";
import { MathProblem } from "../games/MathProblem";
import { HotPotato } from "../games/HotPotato";
import { LumberCut } from "../games/LumberCut";
import { Trivia } from "../games/Trivia";
import { RockPaperScissors } from "../games/RockPaperScissors";
import { Cyclone } from "../games/Cyclone";
import { BalloonInflate } from "../games/BalloonInflate";

export class PracticeRoom extends Room {
  state!: LobbyState;
  maxClients = 1;
  gameLoopInterval: any;
  activeGame: IMiniGame | null = null;

  onCreate(options: any) {
    this.setState(new LobbyState());
    
    // Set game parameters explicitly
    this.state.phase = "playing";
    this.state.currentGameType = "1v1"; // Mock it as 1v1 for standard behavior
    this.state.currentCategory = options.category || "Tapping Race";
    this.state.timer = 10; // Practice duration

    this.onMessage("action", (client, message) => {
      if (this.activeGame && this.state.phase === "playing") {
        this.activeGame.onMessage(client, message, this.state);
      }
    });

    this.instantiateGame();
  }

  onJoin(client: Client, options: any) {
    const p = new Player();
    p.id = client.sessionId;
    p.name = options.name || "Practice Player";
    p.isReady = true;
    p.isHost = true;
    this.state.players.set(client.sessionId, p);
    this.state.selectedPlayers.push(client.sessionId);

    // After the player has officially joined and state is set, trigger init
    if (this.activeGame) {
      this.activeGame.onInit(this.state);
    }
    this.startGameLoop();
  }

  onLeave(client: Client, code?: number) {
    this.state.players.delete(client.sessionId);
    this.disconnect();
  }

  onDispose() {
    if (this.gameLoopInterval) clearInterval(this.gameLoopInterval);
  }

  instantiateGame() {
    switch (this.state.currentCategory) {
      case "Tapping Race": this.activeGame = new TappingRace(); break;
      case "Math Problem": this.activeGame = new MathProblem(); break;
      case "Hot Potato": this.activeGame = new HotPotato(); break;
      case "Lumber Cut": this.activeGame = new LumberCut(); break;
      case "Trivia": this.activeGame = new Trivia(); break;
      case "Rock Paper Scissors": this.activeGame = new RockPaperScissors(); break;
      case "Cyclone": this.activeGame = new Cyclone(); break;
      case "Balloon Inflate": this.activeGame = new BalloonInflate(); break;
    }
  }

  startGameLoop() {
    if (this.gameLoopInterval) clearInterval(this.gameLoopInterval);

    this.gameLoopInterval = setInterval(() => {
      if (this.state.phase === "playing") {
        if (this.state.timer > 0) {
          this.state.timer--;
          if (this.activeGame && this.activeGame.onTick) {
            this.activeGame.onTick(this.state);
          }
        } else {
          this.state.phase = "resolution";
          if (this.activeGame) {
            this.activeGame.onEnd(this.state);
          }
        }
      }
    }, 1000);
  }
}
