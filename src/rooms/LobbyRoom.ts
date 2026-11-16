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
import { SimonSays } from "../games/SimonSays";
import { Scrabble } from "../games/Scrabble";
import { ScreenPainting } from "../games/ScreenPainting";
import { Perfection } from "../games/Perfection";
import { applyDoublePoints, applyStandardScoring } from "./scoring";

const GAME_TYPES = ["1v1", "2v2", "BR"];
const CATEGORIES = ["Tapping Race", "Math Problem", "Hot Potato", "Lumber Cut", "Trivia", "Rock Paper Scissors", "Cyclone", "Balloon Inflate", "Simon Says", "Scrabble", "Screen Painting", "Perfection"];
const EXCLUDED_TURBO_GAMES = ["Hot Potato", "Rock Paper Scissors", "Simon Says"];

/** A hand may hold two cards. One extra card is temporary so the player can choose what to drop. */
export const HAND_CAP = 2;
/** Window before the server discards the card the player has held the longest. */
export const PENDING_DISCARD_MS = 15_000;

export class LobbyRoom extends Room {
  state!: LobbyState;
  maxClients = 8;
  gameLoopInterval: any;
  activeGame: IMiniGame | null = null;
  private disconnectedPlayersCache = new Map<string, { score: number, drinks: number, cards: string[], cardAcquiredAt: number[], cardEarnedRounds?: number[], activeEffects: string }>();
  /** Parallel to `player.cards`: lower means held longer. Keyed by session id. */
  private cardAcquiredAt = new Map<string, number[]>();
  private nextAcquiredAt = 1;
  private pendingDiscardTimers = new Map<string, { clear(): void }>();
  private isCardLocked: boolean = false;
  private shieldChainCount: number = 0;

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
      if (!player) return;
      if (this.state.phase === "lobby" || this.state.phase === "wheel" || this.state.phase === "resolution") {
        player.isReady = message.isReady;
      }
      // Remember the press, but do not leave the phase until the extra card is gone.
      if (this.handBlocksActions(player)) return;
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

    this.onMessage("dev_award_card", (client, message) => {
      const hostPlayer = this.state.players.get(client.sessionId);
      if (!hostPlayer || !hostPlayer.isHost) return;

      const targetPlayerId = message.targetPlayerId || client.sessionId;
      const cardId = message.cardId;
      const targetPlayer = this.state.players.get(targetPlayerId);
      if (!targetPlayer || !cardId) return;

      if (!this.awardCard(targetPlayer, cardId)) return;

      const targetClient = this.clients.find(c => c.sessionId === targetPlayerId);
      if (targetClient) {
        targetClient.send("CardAwardedEvent", {
          cardId: cardId,
          earnedRound: targetPlayer.earnedRounds[targetPlayer.earnedRounds.length - 1],
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
      if (!player || this.handBlocksActions(player)) return;

      const cardId = message.cardId;
      if (typeof cardId !== "string") return;
      const cardIndex = this.indexOfUsableCard(player, cardId);
      if (cardIndex === -1) {
        if (this.ownsCardEarnedThisRound(player, cardId)) {
          const owned = this.indexOfCard(player, cardId);
          client.send("CardErrorEvent", {
            cardId,
            code: "earned_this_round",
            earnedRound: player.earnedRounds[owned],
            message: "This card can't be used until next round.",
          });
        }
        return;
      }

      if (cardId === "RESPIN") {
        if ((this.state.phase === "wheel" || this.state.phase === "chart") && !this.isCardLocked) {
          this.isCardLocked = true;
          this.removeCardAt(player, cardIndex);

          // Reset ready status for all players
          this.state.players.forEach(p => p.isReady = false);

          // Broadcast card announcement to all clients
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "RESPIN",
            description: `${player.name} used RESPIN to re-spin the wheel!`,
            message: `${player.name} used RESPIN to re-spin the wheel!`
          });

          // Wait 3 seconds for card popup animation, then trigger wheel spin
          setTimeout(() => {
            this.startWheelPhase();
            setTimeout(() => {
              this.isCardLocked = false;
            }, 3000);
          }, 3000);
        }
      } else if (cardId === "WILD CARD") {
        if ((this.state.phase === "wheel" || this.state.phase === "chart") && !this.isCardLocked) {
          this.isCardLocked = true;
          this.removeCardAt(player, cardIndex);

          const category = message.category || CATEGORIES[0];
          const selectedPlayers = message.selectedPlayers || Array.from(this.state.players.keys()).slice(0, 2);
          const type = message.type || (selectedPlayers.length === 2 ? "1v1" : selectedPlayers.length === 4 ? "2v2" : "BR");

          // Reset ready status for all players
          this.state.players.forEach(p => p.isReady = false);

          // Broadcast card announcement to all clients
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "WILD CARD",
            description: `${player.name} played WILD CARD: Game set to ${category}!`,
            message: `${player.name} played WILD CARD: Game set to ${category}!`
          });

          // Wait 3 seconds for card popup animation, then force wheel state
          setTimeout(() => {
            this.forceWheelPhase(type, category, selectedPlayers);
            setTimeout(() => {
              this.isCardLocked = false;
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

          const earnedRound = player.earnedRounds[cardIndex];
          this.removeCardAt(player, cardIndex);
          let fx: any = {};
          try { fx = JSON.parse(player.activeEffects || "{}"); } catch(e) {}
          fx.turbo = true;
          if (typeof earnedRound === "number") fx.turboEarnedRound = earnedRound;
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

          this.removeCardAt(player, cardIndex);
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
            this.removeCardAt(player, cardIndex);
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
      // Only the open overflow choice may discard. A late pick after the
      // timeout, or a discard with no pending overflow, removes nothing.
      if (!player || !player.pendingDiscard || player.cards.length <= HAND_CAP) return;

      let removed = false;
      if (typeof message.cardIndex === "number" && message.cardIndex >= 0 && message.cardIndex < player.cards.length) {
        removed = this.removeCardAt(player, message.cardIndex);
      } else if (message.cardId) {
        const idx = player.cards.indexOf(message.cardId);
        if (idx !== -1) removed = this.removeCardAt(player, idx);
      }
      if (removed && player.cards.length <= HAND_CAP) {
        this.clearPendingDiscard(player);
        this.checkAllReady();
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
        this.copyHeldCards(
          player,
          oldPlayer.cards,
          this.cardAcquiredAt.get(existingPlayerId),
          oldPlayer.earnedRounds.toArray(),
        );
        player.activeEffects = oldPlayer.activeEffects;
      }
      this.clearPendingDiscardTimer(existingPlayerId);
      this.cardAcquiredAt.delete(existingPlayerId);
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
          this.copyHeldCards(player, cached.cards, cached.cardAcquiredAt, cached.cardEarnedRounds);
        }
        if (cached.activeEffects) {
          player.activeEffects = cached.activeEffects;
        }
      }
      this.disconnectedPlayersCache.delete(nameLower);
      console.log(`[Rejoin] ${player.name} rejoined from offline cache.`);
    }

    // A rejoin must not restore a hand over the cap. Drop the card held longest, same as the 15s timeout.
    this.discardOldestOverCap(player);

    // Resolve host status: if no host exists in the lobby, make this player host
    let hostExists = false;
    this.state.players.forEach(p => {
      if (p.isHost) hostExists = true;
    });
    if (!hostExists && this.state.players.size === 0) {
      player.isHost = true;
    }

    this.state.players.set(client.sessionId, player);
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

  async onLeave(client: Client, consented?: any) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Disconnect ends the choice the same way a timeout does: drop the card held longest.
    this.discardOldestOverCap(player);
    const cardsArray = player.cards.toArray ? player.cards.toArray() : Array.from(player.cards);
    const cardAcquiredAt = [...(this.cardAcquiredAt.get(player.id) ?? [])];
    const cardEarnedRounds = player.earnedRounds.toArray ? player.earnedRounds.toArray() : Array.from(player.earnedRounds);
    player.isConnected = false;

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

    if (consented) {
      console.log(client.sessionId, "consented leave.");
      // Save stats to cache
      this.disconnectedPlayersCache.set(player.name.toLowerCase(), {
        score: player.score,
        drinks: player.drinks,
        cards: cardsArray,
        cardAcquiredAt,
        cardEarnedRounds,
        activeEffects: player.activeEffects || "{}"
      });
      this.removePlayer(client.sessionId);
    } else {
      console.log(client.sessionId, "abnormal leave! Waiting 120s...");
      try {
        await this.allowReconnection(client, 120);
        console.log(client.sessionId, "successfully reconnected!");
        player.isConnected = true;
      } catch (e) {
        console.log(client.sessionId, "grace period expired!");
        // Save stats to cache
        this.disconnectedPlayersCache.set(player.name.toLowerCase(), {
          score: player.score,
          drinks: player.drinks,
          cards: cardsArray,
          cardAcquiredAt,
          cardEarnedRounds,
          activeEffects: player.activeEffects || "{}"
        });
        this.removePlayer(client.sessionId);
      }
    }
  }

  /**
   * The only place a card is awarded into a hand.
   * Stamps `earnedRound` here, before `pushCard`. A Turbo refund may pass the
   * card's original round so the refund is not a new award. Reconnect restores
   * cards through `copyHeldCards` and must not re-stamp them.
   * Returns false when the hand already has its temporary third card; that award is skipped.
   */
  private awardCard(player: Player, cardId: string, earnedRound?: number): boolean {
    if (player.pendingDiscard || player.cards.length > HAND_CAP) {
      console.log(`[awardCard] Skipped ${cardId} for ${player.name}: discard already pending`);
      return false;
    }

    this.pushCard(player, cardId, undefined, earnedRound ?? this.currentRound());
    if (player.cards.length > HAND_CAP) {
      this.beginPendingDiscard(player);
    }
    return true;
  }

  /**
   * Round in progress. `roundCount` ticks at the start of resolution, which is
   * also when specialty cards are dealt, so chart/wheel/countdown/playing are
   * still the next round.
   */
  private currentRound(): number {
    if (this.state.phase === "resolution") return this.state.roundCount;
    return this.state.roundCount + 1;
  }

  private pushCard(player: Player, cardId: string, acquiredAt?: number, earnedRound?: number): void {
    const order = this.orderFor(player);
    while (order.length < player.cards.length) {
      order.push(this.nextAcquiredAt++);
    }
    while (player.earnedRounds.length < player.cards.length) {
      player.earnedRounds.push(0);
    }
    let stamp = acquiredAt;
    if (stamp === undefined) {
      stamp = this.nextAcquiredAt++;
    } else if (stamp >= this.nextAcquiredAt) {
      this.nextAcquiredAt = stamp + 1;
    }
    player.cards.push(cardId);
    order.push(stamp);
    player.earnedRounds.push(earnedRound ?? 0);
  }

  private copyHeldCards(player: Player, cards: ArrayLike<string>, acquiredAt?: number[], earnedRounds?: number[]): void {
    const stamps = acquiredAt ?? [];
    const rounds = earnedRounds ?? [];
    const useStamps = stamps.length === cards.length;
    const useRounds = rounds.length === cards.length;
    for (let i = 0; i < cards.length; i++) {
      this.pushCard(
        player,
        cards[i],
        useStamps ? stamps[i] : undefined,
        useRounds ? rounds[i] : undefined,
      );
    }
  }

  private orderFor(player: Player): number[] {
    let order = this.cardAcquiredAt.get(player.id);
    if (!order) {
      order = [];
      this.cardAcquiredAt.set(player.id, order);
    }
    return order;
  }

  private removeCardAt(player: Player, index: number): boolean {
    if (index < 0 || index >= player.cards.length) return false;
    const order = this.cardAcquiredAt.get(player.id);
    if (order && index < order.length) order.splice(index, 1);
    if (index < player.earnedRounds.length) player.earnedRounds.splice(index, 1);
    player.cards.splice(index, 1);
    while (player.earnedRounds.length > player.cards.length) player.earnedRounds.pop();
    return true;
  }

  private indexOfCard(player: Player, cardId: string): number {
    for (let i = 0; i < player.cards.length; i++) {
      if (player.cards[i] === cardId) return i;
    }
    return -1;
  }

  /** First copy of `cardId` earned in an earlier round. A same-round copy is skipped. */
  private indexOfUsableCard(player: Player, cardId: string): number {
    const round = this.currentRound();
    for (let i = 0; i < player.cards.length; i++) {
      if (player.cards[i] !== cardId) continue;
      if ((player.earnedRounds[i] ?? 0) >= round) continue;
      return i;
    }
    return -1;
  }

  private ownsCardEarnedThisRound(player: Player, cardId: string): boolean {
    const round = this.currentRound();
    for (let i = 0; i < player.cards.length; i++) {
      if (player.cards[i] === cardId && (player.earnedRounds[i] ?? 0) >= round) return true;
    }
    return false;
  }

  /** Keep the round the Turbo was earned so a refund is not a new award. */
  private clearTurboForRefund(fx: Record<string, unknown>): number | undefined {
    const refundRound = typeof fx.turboEarnedRound === "number" ? fx.turboEarnedRound : undefined;
    fx.turbo = false;
    delete fx.turboEarnedRound;
    return refundRound;
  }

  private oldestHeldIndex(player: Player): number {
    const order = this.cardAcquiredAt.get(player.id);
    if (!order || order.length !== player.cards.length || player.cards.length === 0) return 0;
    let oldest = 0;
    for (let i = 1; i < order.length; i++) {
      if (order[i] < order[oldest]) oldest = i;
    }
    return oldest;
  }

  private handBlocksActions(player: Player): boolean {
    return player.pendingDiscard || player.cards.length > HAND_CAP;
  }

  private beginPendingDiscard(player: Player): void {
    player.pendingDiscard = true;
    player.pendingDiscardDeadline = Date.now() + PENDING_DISCARD_MS;
    player.isReady = false;
    this.armPendingDiscard(player);
  }

  private armPendingDiscard(player: Player): void {
    this.clearPendingDiscardTimer(player.id);
    const timer = this.clock.setTimeout(() => {
      this.pendingDiscardTimers.delete(player.id);
      if (this.state.players.get(player.id) !== player) return;
      this.discardOldestOverCap(player);
    }, PENDING_DISCARD_MS);
    this.pendingDiscardTimers.set(player.id, timer);
  }

  private clearPendingDiscardTimer(playerId: string): void {
    const timer = this.pendingDiscardTimers.get(playerId);
    if (!timer) return;
    timer.clear();
    this.pendingDiscardTimers.delete(playerId);
  }

  private clearPendingDiscard(player: Player): void {
    player.pendingDiscard = false;
    player.pendingDiscardDeadline = 0;
    this.clearPendingDiscardTimer(player.id);
  }

  /** No pick (15s timeout, disconnect, or rejoin over the cap): drop the card held the longest. */
  private discardOldestOverCap(player: Player): void {
    const overflow = player.cards.length > HAND_CAP;
    // Clear the choice before the hand changes so a discard_card in this same
    // turn cannot remove a second card.
    this.clearPendingDiscard(player);
    if (!overflow) return;
    while (player.cards.length > HAND_CAP) {
      this.removeCardAt(player, this.oldestHeldIndex(player));
    }
    this.checkAllReady();
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

    const sendCardAward = (sessionId: string, player: Player, cardId: string, isLastPlace: boolean) => {
      if (!this.awardCard(player, cardId)) return;
      const client = this.clients.find(c => c.sessionId === sessionId);
      if (client) {
        client.send("CardAwardedEvent", {
          cardId,
          earnedRound: player.earnedRounds[player.earnedRounds.length - 1],
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
    this.clearPendingDiscardTimer(sessionId);
    this.cardAcquiredAt.delete(sessionId);
    const wasHost = this.state.players.get(sessionId)?.isHost;
    this.state.players.delete(sessionId);

    const idx = this.state.selectedPlayers.indexOf(sessionId);
    if (idx !== -1) {
      this.state.selectedPlayers.splice(idx, 1);
    }

    if (wasHost && this.state.players.size > 0) {
      this.ensureConnectedHost();
    }
  }

  checkAllReady() {
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
          if (this.handBlocksActions(p) || !p.isReady) allReady = false;
        }
      });
      if (connectedSelectedCount === 0) allReady = false;
    } else {
      // Everyone connected must be ready
      let connectedCount = 0;
      this.state.players.forEach((player: Player) => {
        if (player.isConnected) {
          connectedCount++;
          if (this.handBlocksActions(player) || !player.isReady) allReady = false;
        }
      });
      if (connectedCount === 0) allReady = false;
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
    this.isCardLocked = false;
    this.shieldChainCount = 0;
    this.state.phase = "wheel";
    this.state.currentGameType = GAME_TYPES[Math.floor(Math.random() * GAME_TYPES.length)];
    this.state.currentCategory = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];

    // Enforce Category Restrictions
    if (this.state.currentCategory === "Rock Paper Scissors" || this.state.currentCategory === "Simon Says" || this.state.currentCategory === "Perfection") {
      if (this.state.currentGameType === "2v2") this.state.currentGameType = "1v1";
    } else if (this.state.currentCategory === "Hot Potato" && this.state.currentGameType === "2v2") {
      this.state.currentGameType = "1v1"; // Fallback from 2v2 for Hot Potato
    }

    // Refund any active Turbo cards if category is excluded
    if (EXCLUDED_TURBO_GAMES.includes(this.state.currentCategory)) {
      this.state.players.forEach(p => {
        if (p.activeEffects) {
          try {
            const fx = JSON.parse(p.activeEffects);
            if (fx.turbo) {
              const refundRound = this.clearTurboForRefund(fx);
              p.activeEffects = JSON.stringify(fx);
              this.awardCard(p, "TURBO", refundRound);
            }
          } catch(e) {}
        }
      });
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
    this.isCardLocked = false;
    this.shieldChainCount = 0;
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
              const refundRound = this.clearTurboForRefund(fx);
              p.activeEffects = JSON.stringify(fx);
              this.awardCard(p, "TURBO", refundRound);
            }
          } catch(e) {}
        }
      });
    }

    this.state.selectedPlayers.clear();
    selectedPlayerIds.forEach(id => this.state.selectedPlayers.push(id));

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
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

  private stopPendingDiscardTimers(): void {
    for (const timer of this.pendingDiscardTimers.values()) timer.clear();
    this.pendingDiscardTimers.clear();
  }

  // Keep this method to the timer cleanup. A branch that also defines onDispose
  // (it clears the game-loop interval) must be merged into this one method.
  onDispose() {
    this.stopPendingDiscardTimers();
  }
}
