import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";
import { DEFAULT_TOTAL_ROUNDS } from "../matchLength";

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("boolean") isReady: boolean = false; // Lobby, chart (Ready to Spin), wheel, and resolution toggle
  @type("boolean") isHost: boolean = false;
  @type("number") score: number = 5;
  @type("number") drinks: number = 0;
  @type("number") gameScore: number = 0; // Transient scoring (taps, points)
  @type("string") gameData: string = ""; // Temporary JSON schema state
  @type("boolean") isConnected: boolean = true;
  @type(["string"]) cards = new ArraySchema<string>();
  @type("string") activeEffects: string = ""; // JSON string e.g. {"turbo":true,"doublePoints":true}
}

/** One seat on the end-of-match podium. `place` is 1, 2, or 3. Ties share a place. */
export class PodiumEntry extends Schema {
  @type("number") place: number = 0;
  @type("string") playerId: string = "";
  @type("string") name: string = "";
  @type("number") score: number = 0;
}

export class LobbyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("string") phase: string = "lobby"; // lobby, chart, wheel, countdown, playing, resolution, gameover
  @type("string") currentGameType: string = "";
  @type("string") currentCategory: string = "";
  @type(["string"]) selectedPlayers = new ArraySchema<string>();
  @type("number") timer: number = 0; // Universal server clock
  @type(["string"]) lastWinners = new ArraySchema<string>();
  @type(["string"]) lastLosers = new ArraySchema<string>();
  @type("string") lastGameResult: string = "";
  /**
   * Resolutions that have started. Same increment as master: +1 at the
   * start of resolution, before specialty cards are dealt. Unchanged during
   * lobby, chart, wheel, countdown, and playing, and unchanged when a round
   * aborts before resolution. Round X/N is `roundCount` during resolution
   * and gameover, and `roundCount + 1` during chart, wheel, countdown, and playing.
   */
  @type("number") roundCount: number = 0;
  /** Host-chosen match length. Default 10. One of 10, 15, 20, 30, 40, 50. */
  @type("number") totalRounds: number = DEFAULT_TOTAL_ROUNDS;
  /** Empty until the match ends. Places 1–3, with tied players sharing a place. */
  @type([PodiumEntry]) podium = new ArraySchema<PodiumEntry>();
  /** Connected players with isReady. Chart shows readyCount/connectedCount. */
  @type("number") readyCount: number = 0;
  /** Connected players. Disconnected seats are excluded from the ready count. */
  @type("number") connectedCount: number = 0;
}
