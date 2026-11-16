import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

/**
 * One player's merged drink total for this resolution.
 * A pass that lands on someone who already owes drinks is added to this total.
 * `LobbyState.drinkChains` is keyed by `holderId`.
 * Clients read `drinksToPass` for the PASS label (the amount the next Shield sends).
 */
export class DrinkChain extends Schema {
  /** Same as `holderId`. The map key on `drinkChains`. */
  @type("string") id: string = "";
  @type("string") holderId: string = "";
  /** Merged drinks this player currently owes for this resolution. */
  @type("number") drinks: number = 0;
  /** Deflections already included in this total. 0 means an untouched loss. */
  @type("number") deflections: number = 0;
  /**
   * Amount the holder's next Shield will pass.
   * An untouched loss passes `drinks`. Once any deflection is part of the total, the next pass is `drinks + 1`. No cap.
   */
  @type("number") drinksToPass: number = 0;
}

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("boolean") isReady: boolean = false;
  @type("boolean") isHost: boolean = false;
  @type("number") score: number = 5;
  @type("number") drinks: number = 0;
  @type("number") gameScore: number = 0; // Transient scoring (taps, points)
  @type("string") gameData: string = ""; // Temporary JSON schema state
  @type("boolean") isConnected: boolean = true;
  @type(["string"]) cards = new ArraySchema<string>();
  @type("string") activeEffects: string = ""; // JSON string e.g. {"turbo":true,"doublePoints":true}
}

export class LobbyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("string") phase: string = "lobby"; // lobby, chart, wheel, countdown, playing, resolution
  @type("string") currentGameType: string = "";
  @type("string") currentCategory: string = "";
  @type(["string"]) selectedPlayers = new ArraySchema<string>();
  @type("number") timer: number = 0; // Universal server clock
  @type(["string"]) lastWinners = new ArraySchema<string>();
  @type(["string"]) lastLosers = new ArraySchema<string>();
  /** One merged drink total per holder this resolution. Keyed by holder session id. */
  @type({ map: DrinkChain }) drinkChains = new MapSchema<DrinkChain>();
  @type("string") lastGameResult: string = "";
  @type("number") roundCount: number = 0;
}
