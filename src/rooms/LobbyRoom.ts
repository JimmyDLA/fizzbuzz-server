import { Room, Client, ServerError } from "@colyseus/core";
import { LobbyState, Player } from "./schema/LobbyState";
import { IMiniGame } from "../games/IMiniGame";
import { TappingRace } from "../games/TappingRace";
import { MathProblem } from "../games/MathProblem";
import { HotPotato } from "../games/HotPotato";
import { LumberCut } from "../games/LumberCut";
import { Trivia } from "../games/Trivia";
import { RockPaperScissors } from "../games/RockPaperScissors";
import { ScreenPainting } from "../games/ScreenPainting";

const GAME_TYPES = ["1v1", "2v2", "BR"];
const CATEGORIES = ["Tapping Race", "Math Problem", "Hot Potato", "Lumber Cut", "Trivia", "Rock Paper Scissors", "Screen Painting"];

export class LobbyRoom extends Room {
  state!: LobbyState;
  maxClients = 8;
  gameLoopInterval: any;
  activeGame: IMiniGame | null = null;

  onAuth(client: Client, options: any, request: any) {
    const requestedName = options?.name?.trim();
    if (!requestedName) {
      throw new ServerError(400, "Name is required");
    }

    let isTaken = false;
    this.state.players.forEach((p) => {
      if (p.name.toLowerCase() === requestedName.toLowerCase()) {
        isTaken = true;
      }
    });

    if (isTaken) {
      throw new ServerError(400, `The name "${requestedName}" is already taken! Try another.`);
    }

    return true;
  }

  onCreate(options: any) {
    this.roomId = Math.floor(1000 + Math.random() * 9000).toString();
    this.setState(new LobbyState());

    this.onMessage("ready", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (player && (this.state.phase === "lobby" || this.state.phase === "wheel" || this.state.phase === "resolution")) {
        player.isReady = message.isReady;
      }
      this.checkAllReady();
    });

    this.onMessage("start_wheel", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (player && player.isHost && this.state.phase === "chart") {
        this.startWheelPhase();
      }
    });

    this.onMessage("dev_start_wheel", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (player && player.isHost && this.state.phase === "chart") {
        this.forceWheelPhase(message.type, message.category, message.selectedPlayers);
      }
    });

    this.onMessage("game_action", (client, message) => {
      if (this.state.phase === "playing" && this.activeGame) {
        this.activeGame.onMessage(client, message, this.state);
      }
    });
  }

  onJoin(client: Client, options?: any) {
    console.log(client.sessionId, "joined!");
    const player = new Player();
    player.id = client.sessionId;
    player.name = options?.name || `Player ${this.clients.length}`;

    if (this.clients.length === 1) {
      player.isHost = true;
    }

    this.state.players.set(client.sessionId, player);
  }

  async onLeave(client: Client, consented?: any) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (consented) {
      console.log(client.sessionId, "consented leave.");
      this.removePlayer(client.sessionId);
    } else {
      console.log(client.sessionId, "abnormal leave! Waiting 120s...");
      player.isConnected = false;
      
      try {
        await this.allowReconnection(client, 120);
        console.log(client.sessionId, "successfully reconnected!");
        player.isConnected = true;
      } catch (e) {
        console.log(client.sessionId, "grace period expired!");
        this.removePlayer(client.sessionId);
      }
    }
  }

  private removePlayer(sessionId: string) {
    const wasHost = this.state.players.get(sessionId)?.isHost;
    this.state.players.delete(sessionId);
    
    if (wasHost && this.state.players.size > 0) {
      const firstPlayerKey = Array.from(this.state.players.keys())[0];
      const newHost = this.state.players.get(firstPlayerKey);
      if (newHost) newHost.isHost = true;
    }
  }

  checkAllReady() {
    if (this.clients.length < 1) return;
    let allReady = true;

    if (this.state.phase === "wheel" || this.state.phase === "resolution") {
      // ONLY selected players need to be ready
      const required = this.state.selectedPlayers.toArray();
      required.forEach(id => {
        const p = this.state.players.get(id);
        if (p && !p.isReady) allReady = false;
      });
      if (required.length === 0) allReady = false;
    } else {
      // Everyone must be ready
      this.state.players.forEach((player: Player) => {
        if (!player.isReady) allReady = false;
      });
    }

    if (allReady) {
      if (this.state.phase === "lobby") {
        this.state.players.forEach(p => p.isReady = false);
        this.state.phase = "chart";
      } else if (this.state.phase === "wheel") {
        this.state.players.forEach(p => p.isReady = false);
        this.startCountdownPhase();
      } else if (this.state.phase === "resolution") {
        this.state.players.forEach(p => p.isReady = false);
        this.state.phase = "chart";
      }
    }
  }

  startWheelPhase() {
    this.state.phase = "wheel";
    this.state.currentGameType = GAME_TYPES[Math.floor(Math.random() * GAME_TYPES.length)];
    this.state.currentCategory = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];

    // Enforce Category Restrictions
    if (this.state.currentCategory === "Rock Paper Scissors") {
      this.state.currentGameType = "1v1";
    } else if (this.state.currentCategory === "Screen Painting") {
      if (this.state.currentGameType === "2v2") this.state.currentGameType = "BR";
    } else if (this.state.currentCategory === "Hot Potato" && this.state.currentGameType === "2v2") {
      this.state.currentGameType = "1v1"; // Fallback from 2v2 for Hot Potato
    }

    // Select subset of players
    const allPlayerIds = Array.from(this.state.players.keys());
    for (let i = allPlayerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allPlayerIds[i], allPlayerIds[j]] = [allPlayerIds[j], allPlayerIds[i]];
    }

    let requiredPlayers = allPlayerIds.length;
    if (this.state.currentGameType === "1v1") requiredPlayers = 2;
    if (this.state.currentGameType === "2v2") requiredPlayers = 4;

    // Fallback if not enough players for the drawn game type
    if (requiredPlayers > allPlayerIds.length) {
      if (allPlayerIds.length >= 2) {
        this.state.currentGameType = "1v1";
        requiredPlayers = 2;
      } else {
        this.state.currentGameType = "BR";
        requiredPlayers = allPlayerIds.length;
      }
    }

    this.state.selectedPlayers.clear();
    allPlayerIds.slice(0, requiredPlayers).forEach(id => this.state.selectedPlayers.push(id));

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
  }

  forceWheelPhase(type: string, category: string, selectedPlayerIds: string[]) {
    this.state.phase = "wheel";
    this.state.currentGameType = type;
    this.state.currentCategory = category;

    this.state.selectedPlayers.clear();
    selectedPlayerIds.forEach(id => this.state.selectedPlayers.push(id));

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
  }

  startCountdownPhase() {
    this.state.phase = "countdown";
    this.state.timer = 5;

    this.gameLoopInterval = setInterval(() => {
      this.state.timer--;
      if (this.state.timer <= 0) {
        clearInterval(this.gameLoopInterval);
        this.startPlayingPhase();
      }
    }, 1000);
  }

  startPlayingPhase() {
    this.state.phase = "playing";
    this.state.timer = 20;

    switch (this.state.currentCategory) {
      case "Tapping Race":
        this.activeGame = new TappingRace();
        break;
      case "Math Problem":
        this.activeGame = new MathProblem();
        break;
      case "Hot Potato":
        this.activeGame = new HotPotato();
        break;
      case "Lumber Cut":
        this.activeGame = new LumberCut();
        break;
      case "Trivia":
        this.activeGame = new Trivia();
        this.state.timer = 45; // 3 questions
        break;
      case "Rock Paper Scissors":
        this.activeGame = new RockPaperScissors();
        this.state.timer = 60; // Max duration, usually ends earlier via logic
        break;
      case "Screen Painting":
        this.activeGame = new ScreenPainting();
        this.state.timer = 25; // Race against time
        break;
      default:
        this.activeGame = new TappingRace();
    }

    if (this.activeGame) {
      this.activeGame.onInit(this.state);
    }

    this.gameLoopInterval = setInterval(() => {
      this.state.timer--;

      if (this.activeGame) {
        this.activeGame.onTick(this.state);
      }

      if (this.state.timer <= 0) {
        clearInterval(this.gameLoopInterval);
        if (this.activeGame) {
          this.activeGame.onEnd(this.state);
        }
        this.activeGame = null;
        this.startResolutionPhase();
      }
    }, 1000);
  }

  startResolutionPhase() {
    this.state.phase = "resolution";
    // Server waits indefinitely until chosen clients submit "ready" message to next round
  }
}
