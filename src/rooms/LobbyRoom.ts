import { Room, Client, CloseCode, ServerError } from "@colyseus/core";
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
import { SimonSays } from "../games/SimonSays";
import { Scrabble } from "../games/Scrabble";
import { ScreenPainting } from "../games/ScreenPainting";
import { Perfection } from "../games/Perfection";
import { applyDoublePoints, applyStandardScoring } from "./scoring";
import { MAX_ROOM_PLAYERS, connectedPlayerIds, hasEnoughConnectedPlayers } from "./connectedPlayers";
import { LOBBY_ERROR_EVENT, notEnoughPlayersError } from "./lobbyErrors";

const GAME_TYPES = ["1v1", "2v2", "BR"];

/**
 * Host dev spin. Enabled only when ALLOW_DEV_WHEEL=1 and NODE_ENV is
 * "development" or "test". Off by default, including production.
 */
export const DEV_WHEEL_ENV = "ALLOW_DEV_WHEEL";

export function isDevWheelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const devOrTest = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return devOrTest && env[DEV_WHEEL_ENV] === "1";
}
const CATEGORIES = ["Tapping Race", "Math Problem", "Hot Potato", "Lumber Cut", "Trivia", "Rock Paper Scissors", "Cyclone", "Balloon Inflate", "Simon Says", "Scrabble", "Screen Painting", "Perfection"];
const EXCLUDED_TURBO_GAMES = ["Hot Potato", "Rock Paper Scissors", "Simon Says"];

/** How long an abnormal disconnect keeps its roster seat. */
export const RECONNECT_GRACE_SECONDS = 120;

export class LobbyRoom extends Room {
  state!: LobbyState;
  maxClients = MAX_ROOM_PLAYERS;
  gameLoopInterval: any;
  activeGame: IMiniGame | null = null;
  private disconnectedPlayersCache = new Map<string, { score: number, drinks: number, cards: string[], activeEffects: string }>();
  private isCardLocked: boolean = false;
  private shieldChainCount: number = 0;
  /** Session ids inside the reconnect grace window. They hold a seat until they return or the window ends. */
  private graceSessionIds = new Set<string>();

  onAuth(client: Client, options: any, request: any) {
    const requestedName = options?.name?.trim();
    if (!requestedName) {
      throw new ServerError(400, "Name is required");
    }

    let isTaken = false;
    this.state.players.forEach((p) => {
      if (p.name.toLowerCase() === requestedName.toLowerCase() && p.isConnected) {
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
      const canReady = !!player && (
        this.state.phase === "lobby" ||
        this.state.phase === "chart" ||
        this.state.phase === "wheel" ||
        this.state.phase === "resolution"
      );
      if (canReady && player) {
        player.isReady = message.isReady;
      }
      const blocksOnFloor = this.state.phase === "lobby" || this.state.phase === "chart";
      if (canReady && message?.isReady === true && blocksOnFloor && !hasEnoughConnectedPlayers(this.state.players)) {
        client.send(LOBBY_ERROR_EVENT, notEnoughPlayersError());
      }
      this.checkAllReady();
    });

    // Player-facing host spin is gone. The wheel starts only when every
    // connected player is ready during chart. Ignore leftover clients.
    this.onMessage("start_wheel", () => {});

    this.onMessage("dev_start_wheel", (client, message) => {
      if (!isDevWheelEnabled()) return;
      const player = this.state.players.get(client.sessionId);
      if (player && player.isHost && this.state.phase === "chart") {
        const selectedPlayers = Array.isArray(message?.selectedPlayers) ? message.selectedPlayers : [];
        if (!this.forceWheelPhase(message?.type, message?.category, selectedPlayers)) {
          client.send(LOBBY_ERROR_EVENT, notEnoughPlayersError());
        }
      }
    });

    this.onMessage("dev_award_card", (client, message) => {
      const hostPlayer = this.state.players.get(client.sessionId);
      if (!hostPlayer || !hostPlayer.isHost) return;

      const targetPlayerId = message.targetPlayerId || client.sessionId;
      const cardId = message.cardId;
      const targetPlayer = this.state.players.get(targetPlayerId);
      if (!targetPlayer || !cardId) return;

      targetPlayer.cards.push(cardId);

      const targetClient = this.clients.find(c => c.sessionId === targetPlayerId);
      if (targetClient) {
        targetClient.send("CardAwardedEvent", {
          cardId: cardId,
          reason: "DEV OVERRIDE",
          message: `Dev granted you a ${cardId} card!`
        });
      }
    });

    this.onMessage("game_action", (client, message) => {
      if (this.state.phase === "playing" && this.activeGame) {
        this.activeGame.onMessage(client, message, this.state);
      }
    });

    this.onMessage("use_card", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const cardId = message.cardId;
      const cardIndex = player.cards.indexOf(cardId);
      if (cardIndex === -1) return; // Player doesn't own card

      if (cardId === "RESPIN") {
        if ((this.state.phase === "wheel" || this.state.phase === "chart") && !this.isCardLocked) {
          this.isCardLocked = true;
          player.cards.splice(cardIndex, 1);

          // Reset ready status for all players
          this.clearReadyFlags();

          // Broadcast card announcement to all clients
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "RESPIN",
            description: `${player.name} used RESPIN to re-spin the wheel!`,
            message: `${player.name} used RESPIN to re-spin the wheel!`
          });

          // Wait 3 seconds for card popup animation, then trigger wheel spin.
          // Ready presses during the lock must not start a second spin or the countdown.
          setTimeout(() => {
            this.startWheelPhase();
            setTimeout(() => {
              this.isCardLocked = false;
              this.checkAllReady();
            }, 3000);
          }, 3000);
        }
      } else if (cardId === "WILD CARD") {
        if ((this.state.phase === "wheel" || this.state.phase === "chart") && !this.isCardLocked) {
          this.isCardLocked = true;
          player.cards.splice(cardIndex, 1);

          const category = message.category || CATEGORIES[0];
          const selectedPlayers = message.selectedPlayers || connectedPlayerIds(this.state.players).slice(0, 2);
          const type = message.type || (selectedPlayers.length === 2 ? "1v1" : selectedPlayers.length === 4 ? "2v2" : "BR");

          // Reset ready status for all players
          this.clearReadyFlags();

          // Broadcast card announcement to all clients
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "WILD CARD",
            description: `${player.name} played WILD CARD: Game set to ${category}!`,
            message: `${player.name} played WILD CARD: Game set to ${category}!`
          });

          // Wait 3 seconds for card popup animation, then force wheel state.
          // All-ready must not preempt this play, and the countdown waits until it lands.
          setTimeout(() => {
            this.forceWheelPhase(type, category, selectedPlayers);
            setTimeout(() => {
              this.isCardLocked = false;
              this.checkAllReady();
            }, 3000);
          }, 3000);
        }
      } else if (cardId === "TURBO") {
        if (this.state.phase === "wheel" || this.state.phase === "chart") {
          // Validate participant
          if (!this.state.selectedPlayers.includes(client.sessionId)) {
            return;
          }
          // Validate not excluded game
          if (EXCLUDED_TURBO_GAMES.includes(this.state.currentCategory)) {
            return;
          }

          player.cards.splice(cardIndex, 1);
          let fx: any = {};
          try { fx = JSON.parse(player.activeEffects || "{}"); } catch(e) {}
          fx.turbo = true;
          player.activeEffects = JSON.stringify(fx);
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "TURBO",
            description: `${player.name} activated TURBO for 1.5x score!`,
            message: `${player.name} activated TURBO for 1.5x score!`
          });
        }
      } else if (cardId === "DOUBLE POINTS") {
        if (this.state.phase === "wheel" || this.state.phase === "chart") {
          // Validate participant
          if (!this.state.selectedPlayers.includes(client.sessionId)) {
            return;
          }

          player.cards.splice(cardIndex, 1);
          let fx: any = {};
          try { fx = JSON.parse(player.activeEffects || "{}"); } catch(e) {}
          fx.doublePoints = true;
          player.activeEffects = JSON.stringify(fx);
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "DOUBLE POINTS",
            description: `${player.name} activated DOUBLE POINTS!`,
            message: `${player.name} activated DOUBLE POINTS!`
          });
        }
      } else if (cardId === "SHIELD") {
        if (this.state.phase === "resolution") {
          const targetPlayerId = message.targetPlayerId;
          const targetPlayer = this.state.players.get(targetPlayerId);
          const currentDrinks = this.state.lastLosers.filter(id => id === client.sessionId).length;

          // Prevent shielding self
          if (currentDrinks > 0 && targetPlayer && targetPlayerId !== client.sessionId) {
            player.cards.splice(cardIndex, 1);
            this.shieldChainCount += 1;

            // Remove all occurrences of user from lastLosers
            while (this.state.lastLosers.indexOf(client.sessionId) !== -1) {
              const idx = this.state.lastLosers.indexOf(client.sessionId);
              this.state.lastLosers.splice(idx, 1);
            }

            // Deduct currentDrinks from player drinks counter
            player.drinks = Math.max(0, player.drinks - currentDrinks);

            // Escalate drinks penalty: 1st shield passes currentDrinks (e.g. 1), subsequent chained shields increment by +1 (2x, 3x, 4x, 5x...)
            const drinksToPass = this.shieldChainCount === 1 ? currentDrinks : currentDrinks + 1;

            // Add escalated drinks to target player
            targetPlayer.drinks += drinksToPass;

            // Pass all escalated drinks to target player in lastLosers
            for (let i = 0; i < drinksToPass; i++) {
              this.state.lastLosers.push(targetPlayerId);
            }

            const drinkStr = drinksToPass > 1 ? `${drinksToPass} drinks` : "the drink";
            this.broadcast("CardUsedEvent", {
              userId: client.sessionId,
              playerName: player.name,
              cardId: "SHIELD",
              targetName: targetPlayer.name,
              drinkCount: drinksToPass,
              description: `${player.name} used SHIELD to pass ${drinkStr} to ${targetPlayer.name}!`,
              message: `${player.name} used SHIELD to pass ${drinkStr} to ${targetPlayer.name}!`
            });
          }
        }
      }
    });

    this.onMessage("discard_card", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      if (typeof message.cardIndex === "number" && message.cardIndex >= 0 && message.cardIndex < player.cards.length) {
        player.cards.splice(message.cardIndex, 1);
      } else if (message.cardId) {
        const idx = player.cards.indexOf(message.cardId);
        if (idx !== -1) {
          player.cards.splice(idx, 1);
        }
      }
    });
  }

  onJoin(client: Client, options: any) {
    console.log(client.sessionId, "joined!", options);

    const player = new Player();
    player.id = client.sessionId;
    player.name = options.name?.trim() || `Player ${this.state.players.size + 1}`;
    player.score = 0;
    player.isReady = false;
    player.isConnected = true;

    const nameLower = player.name.toLowerCase();

    // Check if player is reconnecting with the same name
    let existingPlayerId: string | null = null;
    this.state.players.forEach((p, sessionId) => {
      if (p.name.toLowerCase() === nameLower && !p.isConnected) {
        existingPlayerId = sessionId;
      }
    });

    if (existingPlayerId) {
      // Inherit state from the disconnected session
      const oldPlayer = this.state.players.get(existingPlayerId);
      if (oldPlayer) {
        player.score = oldPlayer.score;
        player.drinks = oldPlayer.drinks;
        player.isHost = oldPlayer.isHost;
        player.cards.push(...oldPlayer.cards);
        player.activeEffects = oldPlayer.activeEffects;
      }
      // Remove the old player object
      this.state.players.delete(existingPlayerId);
      console.log(`[Rejoin] ${player.name} rejoined from active disconnected session.`);
    } else if (this.disconnectedPlayersCache.has(nameLower)) {
      // Inherit stats from cache
      const cached = this.disconnectedPlayersCache.get(nameLower);
      if (cached) {
        player.score = cached.score;
        player.drinks = cached.drinks;
        if (cached.cards && cached.cards.length > 0) {
          player.cards.push(...cached.cards);
        }
        if (cached.activeEffects) {
          player.activeEffects = cached.activeEffects;
        }
      }
      this.disconnectedPlayersCache.delete(nameLower);
      console.log(`[Rejoin] ${player.name} rejoined from offline cache.`);
    }

    // Resolve host status: if no host exists in the lobby, make this player host
    let hostExists = false;
    this.state.players.forEach(p => {
      if (p.isHost) hostExists = true;
    });
    if (!hostExists && this.state.players.size === 0) {
      player.isHost = true;
    }

    this.state.players.set(client.sessionId, player);
    // A joiner is not ready. Re-check so they cannot inherit an all-ready spin.
    this.checkAllReady();
  }

  private abortGameToChart(reason: string) {
    console.log(`[AbortGame] Aborting game to chart. Reason: ${reason}`);
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.activeGame = null;
    this.isCardLocked = false;
    this.shieldChainCount = 0;
    this.state.phase = "chart";
    this.state.timer = 0;
    this.state.selectedPlayers.clear();
    this.state.players.forEach(p => {
      p.isReady = false;
      p.gameData = "{}";
      p.gameScore = 0;
    });
    this.syncReadyCounts();
    this.state.lastWinners.clear();
    this.state.lastLosers.clear();
    this.state.lastGameResult = "";
  }

  private ensureConnectedHost() {
    let hasConnectedHost = false;
    this.state.players.forEach(p => {
      if (p.isConnected && p.isHost) {
        hasConnectedHost = true;
      }
    });

    if (!hasConnectedHost) {
      for (const [, p] of this.state.players.entries()) {
        if (p.isConnected) {
          p.isHost = true;
          console.log(`[Host] Promoted ${p.name} to host.`);
          break;
        }
      }
    }
  }

  /**
   * Live sockets plus seat reservations. A reconnect-grace reservation is included,
   * so a full room stays full until that player returns or the grace window ends.
   */
  heldSeatCount(): number {
    const reservedIds = new Set(Object.keys(
      (this as unknown as { _reservedSeats?: Record<string, unknown> })._reservedSeats ?? {},
    ));
    let unreservedGrace = 0;
    for (const sessionId of this.graceSessionIds) {
      const stillSeated = this.clients.some((connected) => connected.sessionId === sessionId);
      if (!stillSeated && !reservedIds.has(sessionId)) unreservedGrace += 1;
    }
    return this.clients.length + reservedIds.size + unreservedGrace;
  }

  isAtSeatCapacity(): boolean {
    return this.heldSeatCount() >= MAX_ROOM_PLAYERS;
  }

  async onLeave(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const cardsArray = player.cards.toArray ? player.cards.toArray() : Array.from(player.cards);
    player.isConnected = false;
    this.syncReadyCounts();

    // Check if player was part of the current active game session
    const isMidGame = this.state.phase === "playing" || this.state.phase === "countdown" || this.state.phase === "wheel";
    const isInSelected = this.state.selectedPlayers.includes(client.sessionId);

    if (isMidGame && isInSelected) {
      const remainingSelected = this.state.selectedPlayers
        .toArray()
        .filter(id => id !== client.sessionId && this.state.players.get(id)?.isConnected);

      if (this.state.currentGameType === "BR" && remainingSelected.length >= 2) {
        console.log(`[Disconnect] ${player.name} left BR match. Continuing match with ${remainingSelected.length} players.`);
        const idx = this.state.selectedPlayers.indexOf(client.sessionId);
        if (idx !== -1) {
          this.state.selectedPlayers.splice(idx, 1);
        }
        if (this.activeGame && this.activeGame.onPlayerDisconnect) {
          this.activeGame.onPlayerDisconnect(client.sessionId, this.state);
        }
        if (this.state.phase === "wheel") {
          this.checkAllReady();
        }
      } else {
        console.log(`[Disconnect] ${player.name} left ${this.state.currentGameType} match. Aborting game to chart lobby.`);
        this.abortGameToChart(`Player ${player.name} disconnected`);
      }
    } else {
      this.checkAllReady();
    }

    this.ensureConnectedHost();

    if (code === CloseCode.CONSENTED) {
      console.log(client.sessionId, "consented leave.");
      // Save stats to cache
      this.disconnectedPlayersCache.set(player.name.toLowerCase(), {
        score: player.score,
        drinks: player.drinks,
        cards: cardsArray,
        activeEffects: player.activeEffects || "{}"
      });
      this.removePlayer(client.sessionId);
    } else {
      // Hold the seat for the whole grace window, including the moment before
      // Colyseus records the reconnection reservation.
      this.graceSessionIds.add(client.sessionId);
      console.log(client.sessionId, "abnormal leave! Waiting 120s...");
      try {
        await this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
        console.log(client.sessionId, "successfully reconnected!");
        player.isConnected = true;
        this.checkAllReady();
      } catch (e) {
        console.log(client.sessionId, "grace period expired!");
        // Save stats to cache
        this.disconnectedPlayersCache.set(player.name.toLowerCase(), {
          score: player.score,
          drinks: player.drinks,
          cards: cardsArray,
          activeEffects: player.activeEffects || "{}"
        });
        this.removePlayer(client.sessionId);
      } finally {
        this.graceSessionIds.delete(client.sessionId);
      }
    }
  }

  distributeSpecialtyCards() {
    const playerEntries = Array.from(this.state.players.entries()).filter(([, p]) => p.isConnected);
    if (playerEntries.length < 1) return;

    const totalPlayer = playerEntries.length;
    const totalSpecCards = Math.max(1, Math.floor(totalPlayer / 2));

    const CARDS_ROSTER = [
      { id: "RESPIN", rarity: 3 },
      { id: "SHIELD", rarity: 3 },
      { id: "TURBO", rarity: 2 },
      { id: "DOUBLE POINTS", rarity: 2 },
      { id: "WILD CARD", rarity: 1 },
    ];

    const generateWeightedCard = () => {
      const pool = [
        "RESPIN", "RESPIN", "RESPIN", "RESPIN",
        "SHIELD", "SHIELD", "SHIELD", "SHIELD",
        "TURBO", "TURBO",
        "DOUBLE POINTS", "DOUBLE POINTS",
        "WILD CARD"
      ];
      return pool[Math.floor(Math.random() * pool.length)];
    };

    const getRarity = (id: string) => CARDS_ROSTER.find(c => c.id === id)?.rarity ?? 3;

    const generatedCards: string[] = [];
    for (let i = 0; i < totalSpecCards; i++) {
      generatedCards.push(generateWeightedCard());
    }
    generatedCards.sort((a, b) => getRarity(a) - getRarity(b));

    const rankedEntries = [...playerEntries].sort(([, a], [, b]) => {
      if (a.score !== b.score) return a.score - b.score;
      return b.drinks - a.drinks;
    });

    const sendCardAward = (sessionId: string, player: any, cardId: string, isLastPlace: boolean) => {
      player.cards.push(cardId);
      const client = this.clients.find(c => c.sessionId === sessionId);
      if (client) {
        client.send("CardAwardedEvent", {
          cardId,
          reason: isLastPlace ? "last_place" : "round_reward",
          message: isLastPlace
            ? "UNDERDOG BOOST — You earned the best card for being in last place!"
            : "ROUND REWARD — You earned a specialty card!",
        });
      }
      console.log(`[SpecialtyCard] Card ${cardId} awarded to ${player.name}`);
    };

    const [lastPlaceSessionId, lastPlacePlayer] = rankedEntries[0];
    const rarestCard = generatedCards.shift();
    if (rarestCard && lastPlacePlayer) {
      sendCardAward(lastPlaceSessionId, lastPlacePlayer, rarestCard, true);
    }

    const otherEntries = rankedEntries.filter(([id]) => id !== lastPlaceSessionId);
    for (let i = otherEntries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [otherEntries[i], otherEntries[j]] = [otherEntries[j], otherEntries[i]];
    }

    let otherIdx = 0;
    while (generatedCards.length > 0) {
      const card = generatedCards.shift()!;
      const [sid, targetPlayer] = otherIdx < otherEntries.length
        ? otherEntries[otherIdx++]
        : [lastPlaceSessionId, lastPlacePlayer];
      sendCardAward(sid, targetPlayer, card, false);
    }
  }

  private removePlayer(sessionId: string) {
    const wasHost = this.state.players.get(sessionId)?.isHost;
    this.state.players.delete(sessionId);

    const idx = this.state.selectedPlayers.indexOf(sessionId);
    if (idx !== -1) {
      this.state.selectedPlayers.splice(idx, 1);
    }

    if (wasHost && this.state.players.size > 0) {
      this.ensureConnectedHost();
    }
    this.syncReadyCounts();
  }

  /** Connected ready players over connected players. Disconnected seats are omitted. */
  private syncReadyCounts() {
    let readyCount = 0;
    let connectedCount = 0;
    this.state.players.forEach((player) => {
      if (!player.isConnected) return;
      connectedCount += 1;
      if (player.isReady) readyCount += 1;
    });
    this.state.readyCount = readyCount;
    this.state.connectedCount = connectedCount;
  }

  private clearReadyFlags() {
    this.state.players.forEach((player) => {
      player.isReady = false;
    });
    this.syncReadyCounts();
  }

  checkAllReady() {
    this.syncReadyCounts();
    if (this.clients.length < 1) return;
    let allReady = true;

    if (this.state.phase === "wheel" || this.state.phase === "resolution") {
      // ONLY selected connected players need to be ready
      const required = this.state.selectedPlayers.toArray();
      let connectedSelectedCount = 0;
      required.forEach(id => {
        const p = this.state.players.get(id);
        if (p && p.isConnected) {
          connectedSelectedCount++;
          if (!p.isReady) allReady = false;
        }
      });
      if (connectedSelectedCount === 0) allReady = false;
    } else {
      // Lobby and chart: every connected player must be ready. Disconnected seats do not block.
      let connectedCount = 0;
      this.state.players.forEach((player: Player) => {
        if (player.isConnected) {
          connectedCount++;
          if (!player.isReady) allReady = false;
        }
      });
      if (connectedCount === 0) allReady = false;
    }

    if (allReady) {
      if (this.state.phase === "lobby") {
        if (!hasEnoughConnectedPlayers(this.state.players)) {
          return;
        }
        this.clearReadyFlags();
        this.state.phase = "chart";
      } else if (this.state.phase === "chart") {
        // No timer and no host override. A card play in flight keeps the Wild Card window.
        if (this.isCardLocked || !hasEnoughConnectedPlayers(this.state.players)) {
          return;
        }
        this.startWheelPhase();
      } else if (this.state.phase === "wheel") {
        if (this.isCardLocked) return;
        this.clearReadyFlags();
        this.startCountdownPhase();
      } else if (this.state.phase === "resolution") {
        this.clearReadyFlags();
        this.state.phase = "chart";
      }
    }
  }

  startWheelPhase(): boolean {
    const contestantIds = connectedPlayerIds(this.state.players);
    if (!hasEnoughConnectedPlayers(this.state.players)) {
      return false;
    }

    let gameType = GAME_TYPES[Math.floor(Math.random() * GAME_TYPES.length)];
    const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];

    // Enforce Category Restrictions
    if (category === "Rock Paper Scissors" || category === "Simon Says" || category === "Perfection") {
      if (gameType === "2v2") gameType = "1v1";
    } else if (category === "Hot Potato" && gameType === "2v2") {
      gameType = "1v1"; // Fallback from 2v2 for Hot Potato
    }

    for (let i = contestantIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [contestantIds[i], contestantIds[j]] = [contestantIds[j], contestantIds[i]];
    }

    let requiredPlayers = contestantIds.length;
    if (gameType === "1v1") requiredPlayers = 2;
    if (gameType === "2v2") requiredPlayers = 4;

    // Not enough connected contestants for the drawn mode. Never start a 1-player BR.
    if (requiredPlayers > contestantIds.length) {
      if (!hasEnoughConnectedPlayers(this.state.players, contestantIds)) {
        return false;
      }
      gameType = "1v1";
      requiredPlayers = 2;
    }

    this.isCardLocked = false;
    this.shieldChainCount = 0;
    // Chart readiness must not carry into the post-wheel Ready to Play step.
    this.clearReadyFlags();
    this.state.phase = "wheel";
    this.state.currentGameType = gameType;
    this.state.currentCategory = category;

    // Refund any active Turbo cards if category is excluded
    if (EXCLUDED_TURBO_GAMES.includes(this.state.currentCategory)) {
      this.state.players.forEach(p => {
        if (p.activeEffects) {
          try {
            const fx = JSON.parse(p.activeEffects);
            if (fx.turbo) {
              fx.turbo = false;
              p.activeEffects = JSON.stringify(fx);
              p.cards.push("TURBO");
            }
          } catch(e) {}
        }
      });
    }

    this.state.selectedPlayers.clear();
    contestantIds.slice(0, requiredPlayers).forEach(id => this.state.selectedPlayers.push(id));

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
    return true;
  }

  forceWheelPhase(type: string, category: string, selectedPlayerIds: string[]): boolean {
    const contestantIds = connectedPlayerIds(this.state.players, selectedPlayerIds);
    if (!hasEnoughConnectedPlayers(this.state.players, contestantIds)) {
      return false;
    }

    this.isCardLocked = false;
    this.shieldChainCount = 0;
    // A Wild Card or dev spin also opens a fresh Ready to Play step.
    this.clearReadyFlags();
    this.state.phase = "wheel";
    this.state.currentGameType = type;
    this.state.currentCategory = category;

    // Refund any active Turbo cards if category is excluded
    if (EXCLUDED_TURBO_GAMES.includes(this.state.currentCategory)) {
      this.state.players.forEach(p => {
        if (p.activeEffects) {
          try {
            const fx = JSON.parse(p.activeEffects);
            if (fx.turbo) {
              fx.turbo = false;
              p.activeEffects = JSON.stringify(fx);
              p.cards.push("TURBO");
            }
          } catch(e) {}
        }
      });
    }

    this.state.selectedPlayers.clear();
    contestantIds.forEach(id => this.state.selectedPlayers.push(id));

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
    return true;
  }

  startCountdownPhase() {
    this.isCardLocked = false;
    this.state.phase = "countdown";
    this.state.timer = 5;

    this.gameLoopInterval = setInterval(() => {
      this.state.timer--;
      if (this.state.timer <= 0) {
        clearInterval(this.gameLoopInterval);
        if (this.state.phase === "countdown") {
          this.startPlayingPhase();
        }
      }
    }, 1000);
  }

  startPlayingPhase() {
    this.state.phase = "playing";
    this.state.timer = 20;

    // Reset player gameData to prevent stale state propagation from previous rounds
    this.state.players.forEach(p => {
      p.gameData = "{}";
    });

    switch (this.state.currentCategory) {
      case "Tapping Race":
        this.activeGame = new TappingRace();
        break;
      case "Math Problem":
        this.activeGame = new MathProblem();
        this.state.timer = 35; // Generous time for solving math problems
        break;
      case "Hot Potato":
        this.activeGame = new HotPotato();
        break;
      case "Lumber Cut":
        this.activeGame = new LumberCut();
        break;
      case "Trivia":
        this.activeGame = new Trivia();
        this.state.timer = 60; // 5 questions
        break;
      case "Rock Paper Scissors":
        this.activeGame = new RockPaperScissors();
        this.state.timer = 60; // Max duration, usually ends earlier via logic
        break;
      case "Cyclone":
        this.activeGame = new Cyclone();
        this.state.timer = 30; // Max time to hit stop
        break;
      case "Balloon Inflate":
        this.activeGame = new BalloonInflate();
        this.state.timer = 30; // Race to pop balloon
        break;
      case "Simon Says":
        this.activeGame = new SimonSays();
        this.state.timer = 5; // Simon Says controls its own timing loop internally
        break;
      case "Scrabble":
        this.activeGame = new Scrabble();
        this.state.timer = 45; // Generous time for forming words
        break;
      case "Screen Painting":
        this.activeGame = new ScreenPainting();
        this.state.timer = 25; // Race against time
        break;
      case "Perfection":
        this.activeGame = new Perfection();
        this.state.timer = 40; // Race against time
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

      if (this.state.timer < -1) {
        clearInterval(this.gameLoopInterval);
        this.applyActiveGameResult();

        // Give clients 3 seconds to view the end-state/results of the game 
        // BEFORE shifting to the resolution scoreboard phase
        setTimeout(() => {
          if (this.state.phase === "playing") {
            this.activeGame = null;
            this.startResolutionPhase();
          }
        }, 3000);
      }
    }, 1000);
  }

  /**
   * Games only report who won, who drinks, and who tied.
   * Standard +3 / +1 drink is applied here, once, before resolution.
   */
  applyActiveGameResult() {
    if (!this.activeGame) return;
    const result = this.activeGame.onEnd(this.state);
    applyStandardScoring(this.state, result);
  }

  startResolutionPhase() {
    this.isCardLocked = false;
    this.shieldChainCount = 0;
    this.state.phase = "resolution";
    this.state.roundCount += 1;

    // Process DOUBLE POINTS effect for winners
    applyDoublePoints(this.state);

    // Check if roundCount is a multiple of 3 to distribute cards
    if (this.state.roundCount > 0 && this.state.roundCount % 3 === 0) {
      this.distributeSpecialtyCards();
    }

    // Reset activeEffects for all players at end of round
    this.state.players.forEach(p => {
      p.activeEffects = "";
    });
  }
}
