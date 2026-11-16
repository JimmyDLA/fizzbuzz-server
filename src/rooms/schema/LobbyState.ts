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
  /**
   * Points taken into the pot when a betting round starts. 0 on any other round.
   * Capped at min(3, the points the player had). Already removed from `score`.
   */
  @type("number") betWager: number = 0;
  /** Points paid back from the pot when the betting round resolves. 0 until then. */
  @type("number") betPayout: number = 0;
  /**
   * betPayout − betWager once the round resolves. While the round is still
   * being played this is −betWager, matching the points already removed from score.
   */
  @type("number") betNet: number = 0;
  /**
   * 1-based competition rank for this betting round. Ties share the best rank.
   * Set whenever the round has a placement, including a no-action board of
   * all zeros. 0 until then, and 0 after an abort clears the round.
   */
  @type("number") betRank: number = 0;
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
  /**
   * True while the round on screen is a betting round. Before resolution that
   * round is roundCount + 1. During resolution and gameover it is roundCount.
   * The app shows the "Betting round" banner from this flag.
   */
  @type("boolean") isBettingRound: boolean = false;
  /**
   * Sum of the stakes still in play. A player who left for good does not take
   * their stake with them: it stays here and is paid to the seats that remain.
   * 0 outside a locked betting round, and 0 again after an abort clears the display.
   */
  @type("number") bettingPot: number = 0;
  /**
   * True after a no-action betting round returns every wager.
   * Cleared when the next chart is shown, and kept on gameover so the podium
   * can still see that the last pot was returned.
   */
  @type("boolean") bettingRefunded: boolean = false;
}
