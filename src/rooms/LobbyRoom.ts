import { Room, Client, CloseCode, ServerError } from "@colyseus/core";
import { DrinkChain, LobbyState, Player, PodiumEntry } from "./schema/LobbyState";
import { GameResult, IMiniGame } from "../games/IMiniGame";
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
import { applyDoublePoints, applyDrinks, applyNoActionRound, scoreGameResult } from "./scoring";
import {
  BETTING_PAYOUT_EVENT,
  BETTING_ROUND_EVENT,
  BettingPayoutPayload,
  BettingPayoutReason,
  BettingPayoutView,
  BettingRoundPayload,
  BettingWagerView,
  isBettingRound,
  isNoActionResult,
  Placement,
  splitPot,
  standingsForPlayers,
  wagerForPoints,
} from "./betting";
import { claimRoomCodeNow, releaseRoomCode } from "./roomCodes";
import { MAX_ROOM_PLAYERS, connectedPlayerIds, hasEnoughConnectedPlayers } from "./connectedPlayers";
import { LOBBY_ERROR_EVENT, invalidRoundsError, notEnoughPlayersError, notHostError, roundsLockedError } from "./lobbyErrors";
import {
  GAME_OVER_EVENT,
  GameOverPayload,
  RankedPlayer,
  SET_ROUNDS_MESSAGE,
  buildPodium,
  isRoundChoice,
  upcomingRoundNumber,
} from "./matchLength";
import { specialtyCardDropPool, specialtyCardRarity } from "./specialtyCards";

const GAME_TYPES = ["1v1", "2v2", "BR"];
const CATEGORIES = ["Tapping Race", "Math Problem", "Hot Potato", "Lumber Cut", "Trivia", "Rock Paper Scissors", "Cyclone", "Balloon Inflate", "Simon Says", "Scrabble", "Screen Painting", "Perfection"];
const EXCLUDED_TURBO_GAMES = ["Hot Potato", "Rock Paper Scissors", "Simon Says"];

/**
 * Dev-only host tools (`dev_start_wheel`, `dev_award_card`).
 * Enabled only when ALLOW_DEV_TOOLS=1 and NODE_ENV is "development" or "test".
 * Off by default, including production.
 */
export const DEV_TOOLS_ENV = "ALLOW_DEV_TOOLS";

export function isDevToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const devOrTest = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return devOrTest && env[DEV_TOOLS_ENV] === "1";
}

/** How long an abnormal disconnect keeps its roster seat. */
export const RECONNECT_GRACE_SECONDS = 120;

/**
 * Next pass for one chain. The round has no global running total.
 * An untouched chain sends the drinks it currently holds.
 * After that chain has been deflected, the next pass is those drinks plus 1. No cap.
 * Another chain does not change this number. Totals add only when both chains sit on the same holder.
 */
export function shieldDrinksToPass(drinks: number, deflections: number): number {
  return deflections <= 0 ? drinks : drinks + 1;
}

/**
 * How long resolution keeps waiting on a Shield target who is disconnected but still seated.
 * This is the decision window, not the 120s reconnect grace. Jimmy can overrule the length (CRD-017).
 */
export const SHIELD_DECISION_MS = 15_000;

export interface ShieldPassResult {
  /** Merged amount this deflection passed. Same value as CardUsedEvent.drinksToPass. */
  drinksToPass: number;
  holderId: string;
  deflections: number;
}

/** A hand may hold two cards. One extra card is temporary so the player can choose what to drop. */
export const HAND_CAP = 2;
/** Window before the server discards the card the player has held the longest. */
export const PENDING_DISCARD_MS = 15_000;

export class LobbyRoom extends Room {
  state!: LobbyState;
  maxClients = MAX_ROOM_PLAYERS;
  gameLoopInterval: any;
  activeGame: IMiniGame | null = null;
  private disconnectedPlayersCache = new Map<string, { score: number, drinks: number, cards: string[], cardAcquiredAt: number[], activeEffects: string }>();
  /** Parallel to `player.cards`: lower means held longer. Keyed by session id. */
  private cardAcquiredAt = new Map<string, number[]>();
  private nextAcquiredAt = 1;
  private pendingDiscardTimers = new Map<string, { clear(): void }>();
  private isCardLocked: boolean = false;
  /** Set once the podium is in room state and the room is closing. */
  private matchOver: boolean = false;
  /** Session ids inside the reconnect grace window. They hold a seat until they return or the window ends. */
  private graceSessionIds = new Set<string>();
  /** Original join order. A grace reconnect keeps the same number, so host selection stays stable. */
  private nextJoinOrder = 0;
  private joinOrder = new Map<string, number>();
  /** Stakes have been removed from score for the current betting round. */
  private bettingLocked = false;
  /** The pot has been paid or refunded by a game result. Abort will not return it again. */
  private bettingSettled = false;
  /** Players who staked this betting round, in selected order. */
  private bettingPlayerIds: string[] = [];
  /** Stake locked for each player id, including a seat that is later removed. */
  private bettingStakes = new Map<string, number>();
  /** Deadlines for disconnected seated Shield targets. Cleared when they act, the window ends, or the seat is removed. */
  private shieldHold = new Map<string, { deadline: number; acted: boolean }>();
  private shieldHoldTimer: ReturnType<typeof setTimeout> | null = null;
  /** Code held until the room is disposed, including the gap before the matchmaker lists it. */
  private claimedRoomCode: string | null = null;

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

  async onCreate(options: any) {
    // Claim before any await so state exists for callers that do not await onCreate.
    this.assignUniqueRoomCode();

    this.onMessage("ready", (client, message) => {
      if (this.matchOver) return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const canReady = (
        this.state.phase === "lobby" ||
        this.state.phase === "chart" ||
        this.state.phase === "wheel" ||
        this.state.phase === "resolution"
      );
      if (canReady) {
        player.isReady = message.isReady;
        if (message?.isReady && player.isConnected) {
          this.markShieldHoldActed(client.sessionId);
        }
      }
      const blocksOnFloor = this.state.phase === "lobby" || this.state.phase === "chart";
      if (canReady && message?.isReady === true && blocksOnFloor && !hasEnoughConnectedPlayers(this.state.players)) {
        client.send(LOBBY_ERROR_EVENT, notEnoughPlayersError());
      }
      // Remember the press, but do not leave the phase until the extra card is gone.
      if (this.handBlocksActions(player)) return;
      this.checkAllReady();
    });

    // Player-facing host spin is gone. The wheel starts only when every
    // connected player is ready during chart. Ignore leftover clients.
    this.onMessage("start_wheel", () => {});

    this.onMessage(SET_ROUNDS_MESSAGE, (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!this.isCurrentHost(player)) {
        client.send(LOBBY_ERROR_EVENT, notHostError());
        return;
      }
      if (this.state.phase !== "lobby") {
        client.send(LOBBY_ERROR_EVENT, roundsLockedError());
        return;
      }
      const rounds = message?.rounds;
      if (!isRoundChoice(rounds)) {
        client.send(LOBBY_ERROR_EVENT, invalidRoundsError());
        return;
      }
      this.state.totalRounds = rounds;
    });

    this.onMessage("dev_start_wheel", (client, message) => {
      if (!isDevToolsEnabled()) return;
      const player = this.state.players.get(client.sessionId);
      if (player && this.isCurrentHost(player) && this.state.phase === "chart" && !this.matchOver) {
        const selectedPlayers = Array.isArray(message?.selectedPlayers) ? message.selectedPlayers : [];
        if (!this.forceWheelPhase(message?.type, message?.category, selectedPlayers)) {
          client.send(LOBBY_ERROR_EVENT, notEnoughPlayersError());
        }
      }
    });

    this.onMessage("dev_award_card", (client, message) => {
      if (!isDevToolsEnabled()) return;
      const hostPlayer = this.state.players.get(client.sessionId);
      if (!this.isCurrentHost(hostPlayer)) return;

      const targetPlayerId = message.targetPlayerId || client.sessionId;
      const cardId = message.cardId;
      const targetPlayer = this.state.players.get(targetPlayerId);
      if (!targetPlayer || !cardId) return;

      if (!this.awardCard(targetPlayer, cardId)) return;

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
      if (message == null || typeof message !== "object") return;
      if (this.state.phase === "playing" && this.activeGame) {
        this.activeGame.onMessage(client, message, this.state);
      }
    });

    this.onMessage("use_card", (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.handBlocksActions(player)) return;

      const cardId = message.cardId;
      const cardIndex = player.cards.indexOf(cardId);
      if (cardIndex === -1) return; // Player doesn't own card

      if (cardId === "RESPIN") {
        if ((this.state.phase === "wheel" || this.state.phase === "chart") && !this.isCardLocked) {
          this.isCardLocked = true;
          this.removeCardAt(player, cardIndex);

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
          this.removeCardAt(player, cardIndex);

          const category = message.category || CATEGORIES[0];
          const betting = this.roundWillBeBetting();
          // A betting round stays Battle Royale. The card can still pick the game.
          const selectedPlayers = betting
            ? connectedPlayerIds(this.state.players)
            : (message.selectedPlayers || connectedPlayerIds(this.state.players).slice(0, 2));
          const type = betting
            ? "BR"
            : (message.type || (selectedPlayers.length === 2 ? "1v1" : selectedPlayers.length === 4 ? "2v2" : "BR"));

          // Reset ready status for all players
          this.clearReadyFlags();

          const description = betting
            ? `${player.name} played WILD CARD: ${category} stays Battle Royale.`
            : `${player.name} played WILD CARD: Game set to ${category}!`;

          // Broadcast card announcement to all clients
          this.broadcast("CardUsedEvent", {
            userId: client.sessionId,
            playerName: player.name,
            cardId: "WILD CARD",
            description,
            message: description,
            ...(betting ? { forcedBattleRoyale: true } : {}),
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

          this.removeCardAt(player, cardIndex);
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
        this.applyShield(client.sessionId, message.targetPlayerId);
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

  /**
   * Pick a 4-digit code no live room holds. The matchmaker listing is written
   * after onCreate, so the code stays reserved until onDispose.
   */
  private assignUniqueRoomCode(): void {
    this.claimedRoomCode = claimRoomCodeNow();
    try {
      this.roomId = this.claimedRoomCode;
      this.setState(new LobbyState());
    } catch (error) {
      this.releaseClaimedRoomCode();
      throw error;
    }
  }

  private releaseClaimedRoomCode() {
    if (this.claimedRoomCode === null) return;
    releaseRoomCode(this.claimedRoomCode);
    this.claimedRoomCode = null;
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
      // Inherit state from the disconnected session. Host is chosen afterwards,
      // so a stale isHost flag cannot follow the player onto a new session.
      const oldPlayer = this.state.players.get(existingPlayerId);
      if (oldPlayer) {
        player.score = oldPlayer.score;
        player.drinks = oldPlayer.drinks;
        player.betWager = oldPlayer.betWager;
        player.betPayout = oldPlayer.betPayout;
        player.betNet = oldPlayer.betNet;
        player.betRank = oldPlayer.betRank;
        this.copyHeldCards(player, oldPlayer.cards, this.cardAcquiredAt.get(existingPlayerId));
        player.activeEffects = oldPlayer.activeEffects;
      }
      this.keepJoinOrder(client.sessionId, existingPlayerId);
      this.moveBettingSeat(existingPlayerId, client.sessionId);
      this.retargetSelectedPlayer(existingPlayerId, client.sessionId);
      this.clearPendingDiscardTimer(existingPlayerId);
      this.cardAcquiredAt.delete(existingPlayerId);
      this.state.players.delete(existingPlayerId);
      console.log(`[Rejoin] ${player.name} rejoined from active disconnected session.`);
    } else if (this.disconnectedPlayersCache.has(nameLower)) {
      // Inherit stats from cache
      const cached = this.disconnectedPlayersCache.get(nameLower);
      if (cached) {
        player.score = cached.score;
        player.drinks = cached.drinks;
        if (cached.cards && cached.cards.length > 0) {
          this.copyHeldCards(player, cached.cards, cached.cardAcquiredAt);
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
    this.keepJoinOrder(client.sessionId);
    this.state.players.set(client.sessionId, player);
    this.ensureConnectedHost();
    // A joiner is not ready. Re-check so they cannot inherit an all-ready spin.
    this.checkAllReady();
  }

  /** Original join position. Unchanged when a grace player reconnects with the same session. */
  joinSequence(sessionId: string): number {
    const order = this.joinOrder.get(sessionId);
    if (order === undefined) throw new Error(`no join sequence for ${sessionId}`);
    return order;
  }

  private keepJoinOrder(sessionId: string, inheritedFrom?: string) {
    if (inheritedFrom) {
      const inherited = this.joinOrder.get(inheritedFrom);
      this.joinOrder.delete(inheritedFrom);
      if (inherited !== undefined) {
        this.joinOrder.set(sessionId, inherited);
        return;
      }
    }
    if (!this.joinOrder.has(sessionId)) {
      this.joinOrder.set(sessionId, this.nextJoinOrder++);
    }
  }

  /** A name rejoin keeps the same seat in the current round's roster. */
  private retargetSelectedPlayer(fromId: string, toId: string) {
    const index = this.state.selectedPlayers.indexOf(fromId);
    if (index !== -1) this.state.selectedPlayers[index] = toId;
  }

  /** A name rejoin keeps the same stake under the new session id. */
  private moveBettingSeat(fromId: string, toId: string) {
    const wager = this.bettingStakes.get(fromId);
    if (wager === undefined) return;
    this.bettingStakes.delete(fromId);
    this.bettingStakes.set(toId, wager);
    const index = this.bettingPlayerIds.indexOf(fromId);
    if (index !== -1) this.bettingPlayerIds[index] = toId;
  }

  /**
   * Pass this player's drink total. Escalation stays on this chain.
   * A second chain elsewhere in the round does not add a drink.
   * A target who already holds a chain keeps one total: the passed amount is added to it.
   * Any other player is a legal target, including a 2v2 teammate and the player who just passed.
   * The shielder cannot target themselves.
   * Returns null, and does not consume the card, when the play is rejected.
   */
  applyShield(sessionId: string, targetPlayerId: string): ShieldPassResult | null {
    if (this.state.phase !== "resolution") return null;

    const player = this.state.players.get(sessionId);
    const targetPlayer = targetPlayerId ? this.state.players.get(targetPlayerId) : undefined;
    if (!player || !targetPlayer || targetPlayerId === sessionId) return null;

    const cardIndex = player.cards.indexOf("SHIELD");
    if (cardIndex === -1) return null;

    const chain = this.state.drinkChains.get(sessionId);
    if (!chain || chain.drinks <= 0) return null;

    const drinksToPass = shieldDrinksToPass(chain.drinks, chain.deflections);
    const heldDrinks = chain.drinks;
    const passedDeflections = chain.deflections + 1;

    this.removeCardAt(player, cardIndex);
    player.drinks = Math.max(0, player.drinks - heldDrinks);
    targetPlayer.drinks += drinksToPass;

    const targetChain = this.state.drinkChains.get(targetPlayerId);
    const mergedDrinks = targetChain ? targetChain.drinks + drinksToPass : drinksToPass;
    const mergedDeflections = targetChain
      ? Math.max(targetChain.deflections, passedDeflections)
      : passedDeflections;

    this.state.drinkChains.delete(sessionId);
    const merged = this.writeDrinkChain(targetPlayerId, mergedDrinks, mergedDeflections);
    this.syncLastLosersFromChains();

    const drinkStr = drinksToPass > 1 ? `${drinksToPass} drinks` : "the drink";
    this.broadcast("CardUsedEvent", {
      userId: sessionId,
      playerName: player.name,
      cardId: "SHIELD",
      targetName: targetPlayer.name,
      targetPlayerId,
      drinkCount: drinksToPass,
      drinksToPass,
      deflections: merged.deflections,
      description: `${player.name} used SHIELD to pass ${drinkStr} to ${targetPlayer.name}!`,
      message: `${player.name} used SHIELD to pass ${drinkStr} to ${targetPlayer.name}!`
    });

    this.markShieldHoldActed(sessionId);
    this.checkAllReady();

    return {
      drinksToPass,
      holderId: targetPlayerId,
      deflections: merged.deflections,
    };
  }

  /** One merged total per player already in lastLosers. Amount is their current count, usually 1. */
  private seedDrinkChains() {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const id of this.state.lastLosers.toArray()) {
      if (!counts.has(id)) order.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    this.state.drinkChains.clear();
    for (const holderId of order) {
      this.writeDrinkChain(holderId, counts.get(holderId) ?? 0, 0);
    }
    this.syncLastLosersFromChains();
  }

  private writeDrinkChain(holderId: string, drinks: number, deflections: number): DrinkChain {
    let chain = this.state.drinkChains.get(holderId);
    if (!chain) {
      chain = new DrinkChain();
      chain.id = holderId;
      chain.holderId = holderId;
      this.state.drinkChains.set(holderId, chain);
    }
    chain.drinks = drinks;
    chain.deflections = deflections;
    chain.drinksToPass = shieldDrinksToPass(drinks, deflections);
    return chain;
  }

  private syncLastLosersFromChains() {
    this.state.lastLosers.clear();
    this.state.drinkChains.forEach((chain) => {
      for (let i = 0; i < chain.drinks; i++) {
        this.state.lastLosers.push(chain.holderId);
      }
    });
  }

  private clearDrinkChains() {
    this.state.drinkChains.clear();
  }

  /**
   * Drop this holder's drink total when their seat is deleted.
   * Called from removePlayer only. A disconnect that still holds the seat,
   * including the 120s reconnect grace, keeps the chain.
   */
  private dropDrinkChain(sessionId: string) {
    let removed = this.state.drinkChains.delete(sessionId);
    const staleIds: string[] = [];
    this.state.drinkChains.forEach((chain, id) => {
      if (chain.holderId === sessionId) staleIds.push(id);
    });
    for (const id of staleIds) {
      this.state.drinkChains.delete(id);
      removed = true;
    }
    if (removed) this.syncLastLosersFromChains();
  }

  private abortGameToChart(reason: string) {
    console.log(`[AbortGame] Aborting game to chart. Reason: ${reason}`);
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.activeGame = null;
    this.isCardLocked = false;
    this.clearDrinkChains();
    this.clearShieldHolds();
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
    // roundCount is unchanged, so the same round is replayed. Clear the pot
    // for that replay. A settlement that already moved points stays put.
    this.resetBettingAfterAbort();
    this.state.isBettingRound = isBettingRound(upcomingRoundNumber(this.state.roundCount));
  }

  onDispose() {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    for (const timer of this.pendingDiscardTimers.values()) timer.clear();
    this.pendingDiscardTimers.clear();
    this.clearShieldHolds();
    this.releaseClaimedRoomCode();
  }

  /**
   * Host-only actions must use this. True only for the single connected host,
   * so an offline flag cannot change the match length or the dev tools.
   */
  private isCurrentHost(player: Player | undefined): boolean {
    if (!player?.isHost || !player.isConnected) return false;
    let connectedHosts = 0;
    this.state.players.forEach((candidate) => {
      if (candidate.isConnected && candidate.isHost) connectedHosts += 1;
    });
    return connectedHosts === 1;
  }

  /**
   * Whenever at least one player is connected, exactly one connected player is host.
   * An offline host is cleared as soon as someone connected can take the role.
   * A new host is the earliest-joined connected player. An existing connected host
   * is left in place, so a later reconnect does not steal the role.
   */
  private ensureConnectedHost() {
    const connected: Array<{ player: Player; order: number }> = [];
    this.state.players.forEach((player, sessionId) => {
      if (!player.isConnected) return;
      connected.push({ player, order: this.joinOrder.get(sessionId) ?? Number.MAX_SAFE_INTEGER });
    });
    if (connected.length === 0) return;

    const connectedHosts = connected.filter((entry) => entry.player.isHost);
    let host = connectedHosts.length === 1 ? connectedHosts[0].player : undefined;
    if (!host) {
      connected.sort((a, b) => a.order - b.order);
      host = connected[0].player;
      console.log(`[Host] Promoted ${host.name} to host.`);
    }
    this.state.players.forEach((player) => {
      player.isHost = player === host;
    });
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
    if (this.matchOver) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    // Disconnect ends the choice the same way a timeout does: drop the card held longest.
    this.discardOldestOverCap(player);
    const cardsArray = player.cards.toArray ? player.cards.toArray() : Array.from(player.cards);
    const cardAcquiredAt = [...(this.cardAcquiredAt.get(player.id) ?? [])];
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
        cardAcquiredAt,
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
        this.ensureConnectedHost();
        this.checkAllReady();
      } catch (e) {
        console.log(client.sessionId, "grace period expired!");
        // Save stats to cache
        this.disconnectedPlayersCache.set(player.name.toLowerCase(), {
          score: player.score,
          drinks: player.drinks,
          cards: cardsArray,
          cardAcquiredAt,
          activeEffects: player.activeEffects || "{}"
        });
        this.removePlayer(client.sessionId);
      } finally {
        this.graceSessionIds.delete(client.sessionId);
      }
    }
  }

  /**
   * The only place a card is awarded into a hand.
   * A later ticket can stamp award metadata (the round the card was earned) on `cardId` here,
   * before `pushCard`. Reconnect restores cards through `copyHeldCards` and must not re-stamp them.
   * Returns false when the hand already has its temporary third card; that award is skipped.
   */
  private awardCard(player: Player, cardId: string): boolean {
    if (player.pendingDiscard || player.cards.length > HAND_CAP) {
      console.log(`[awardCard] Skipped ${cardId} for ${player.name}: discard already pending`);
      return false;
    }

    this.pushCard(player, cardId);
    if (player.cards.length > HAND_CAP) {
      this.beginPendingDiscard(player);
    }
    return true;
  }

  private pushCard(player: Player, cardId: string, acquiredAt?: number): void {
    const order = this.orderFor(player);
    while (order.length < player.cards.length) {
      order.push(this.nextAcquiredAt++);
    }
    let stamp = acquiredAt;
    if (stamp === undefined) {
      stamp = this.nextAcquiredAt++;
    } else if (stamp >= this.nextAcquiredAt) {
      this.nextAcquiredAt = stamp + 1;
    }
    player.cards.push(cardId);
    order.push(stamp);
  }

  private copyHeldCards(player: Player, cards: ArrayLike<string>, acquiredAt?: number[]): void {
    const stamps = acquiredAt ?? [];
    const useStamps = stamps.length === cards.length;
    for (let i = 0; i < cards.length; i++) {
      this.pushCard(player, cards[i], useStamps ? stamps[i] : undefined);
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
    player.cards.splice(index, 1);
    return true;
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
    const pool = specialtyCardDropPool();
    if (pool.length === 0) return;

    const generatedCards: string[] = [];
    for (let i = 0; i < totalSpecCards; i++) {
      generatedCards.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    // Lowest rarity number is rarest, so the first card after this sort goes to last place.
    generatedCards.sort((a, b) => specialtyCardRarity(a) - specialtyCardRarity(b));

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
    this.joinOrder.delete(sessionId);
    this.clearPendingDiscardTimer(sessionId);
    this.cardAcquiredAt.delete(sessionId);
    this.dropDrinkChain(sessionId);
    this.state.players.delete(sessionId);

    const idx = this.state.selectedPlayers.indexOf(sessionId);
    if (idx !== -1) {
      this.state.selectedPlayers.splice(idx, 1);
    }

    if (this.state.players.size > 0) {
      this.ensureConnectedHost();
    }
    this.shieldHold.delete(sessionId);
    this.syncReadyCounts();
    this.checkAllReady();
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
    if (this.matchOver) return;
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
      // A Shield target who dropped but still has a seat (reconnect grace) keeps
      // resolution open for the decision window. Ready from everyone else does not skip it.
      if (this.state.phase === "resolution" && this.shieldHoldBlocksResolution()) {
        allReady = false;
      }
    } else {
      // Lobby and chart: every connected player must be ready. Disconnected seats do not block.
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
        if (!hasEnoughConnectedPlayers(this.state.players)) {
          return;
        }
        this.clearReadyFlags();
        this.state.phase = "chart";
        this.state.isBettingRound = isBettingRound(upcomingRoundNumber(this.state.roundCount));
      } else if (this.state.phase === "chart") {
        // No timer and no host override. A card play in flight keeps the Wild Card window.
        // roundCount does not change here. The round this spin plays is roundCount + 1.
        // A betting round (that value is a positive multiple of 5, including a final one)
        // forces Battle Royale and locks wagers when the wheel starts.
        if (this.isCardLocked || !hasEnoughConnectedPlayers(this.state.players)) {
          return;
        }
        this.startWheelPhase();
      } else if (this.state.phase === "wheel") {
        if (this.isCardLocked) return;
        this.clearReadyFlags();
        this.startCountdownPhase();
      } else if (this.state.phase === "resolution") {
        // Shields have had the resolution window. Drinks and double points
        // are already applied. The match ends only when this was the last round.
        this.completeRound();
      }
    }
  }

  /**
   * The round on screen. Resolution has already counted itself, so during
   * resolution and gameover the number is `roundCount`. Before that, the
   * spin in progress is `roundCount + 1`.
   */
  private displayedRoundNumber(): number {
    if (this.state.phase === "resolution" || this.state.phase === "gameover") {
      return this.state.roundCount;
    }
    return upcomingRoundNumber(this.state.roundCount);
  }

  /** True when the round on screen is a positive multiple of 5. */
  private roundWillBeBetting(): boolean {
    if (this.matchOver) return false;
    return isBettingRound(this.displayedRoundNumber());
  }

  /**
   * Resolution is finished, including Shield. `roundCount` was already
   * incremented when this resolution started. The final round fills the
   * podium and closes. Any earlier round returns to the chart with the
   * same `roundCount`. An unsettled betting round returns its stakes first.
   */
  private completeRound(): void {
    if (this.matchOver) return;
    const settled = this.bettingSettled;
    if (this.bettingLocked && !this.bettingSettled) {
      this.refundTrackedStakes("unresolved");
    }
    this.clearReadyFlags();
    this.bettingLocked = false;
    this.bettingSettled = false;
    this.bettingPlayerIds = [];
    this.bettingStakes.clear();
    this.clearShieldHolds();
    if (this.state.roundCount >= this.state.totalRounds) {
      this.state.isBettingRound = isBettingRound(this.state.roundCount);
      if (!settled) this.resetBettingDisplay();
      this.endMatch();
      return;
    }
    this.resetBettingDisplay();
    this.state.phase = "chart";
    this.state.isBettingRound = isBettingRound(upcomingRoundNumber(this.state.roundCount));
  }

  private fillPodium(): GameOverPayload {
    const ranked: RankedPlayer[] = [];
    // Rank every seat still in the room. A reconnect-grace seat is disconnected
    // but not removed, so it keeps its place. A consented leave has already
    // deleted that player.
    this.state.players.forEach((player, id) => {
      ranked.push({ id, name: player.name, score: player.score });
    });
    const seats = buildPodium(ranked);
    this.state.podium.clear();
    for (const seat of seats) {
      const entry = new PodiumEntry();
      entry.place = seat.place;
      entry.playerId = seat.playerId;
      entry.name = seat.name;
      entry.score = seat.score;
      this.state.podium.push(entry);
    }
    return {
      roundCount: this.state.roundCount,
      totalRounds: this.state.totalRounds,
      podium: seats,
    };
  }

  /**
   * Put gameover and the podium into room state, push that patch, then the
   * GameOverEvent, then dispose the room so its code is freed.
   */
  private endMatch(): void {
    if (this.matchOver) return;
    // The podium snapshot keeps one connected host. Closing the room does not
    // run onLeave's promotion, because matchOver returns first.
    this.ensureConnectedHost();
    this.matchOver = true;
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.activeGame = null;
    this.isCardLocked = false;
    const payload = this.fillPodium();
    this.state.phase = "gameover";
    this.broadcastPatch();
    this.broadcast(GAME_OVER_EVENT, payload);
    void this.disconnect();
  }

  /**
   * Current drink holders who still have a Shield and can deflect.
   * A disconnected one who is still in `players` is seated (grace). Removing the seat ends the hold.
   */
  private currentShieldTargets(): string[] {
    const ids: string[] = [];
    this.state.drinkChains.forEach((chain) => {
      const player = this.state.players.get(chain.holderId);
      if (!player || chain.drinks <= 0) return;
      if (player.cards.indexOf("SHIELD") === -1) return;
      ids.push(chain.holderId);
    });
    return ids;
  }

  private shieldHoldBlocksResolution(): boolean {
    const now = Date.now();
    const targets = new Set(this.currentShieldTargets());
    for (const id of [...this.shieldHold.keys()]) {
      if (!this.state.players.has(id) || !targets.has(id)) this.shieldHold.delete(id);
    }
    for (const id of targets) {
      const player = this.state.players.get(id);
      if (!player || player.isConnected) continue;
      if (!this.shieldHold.has(id)) {
        this.shieldHold.set(id, { deadline: now + SHIELD_DECISION_MS, acted: false });
      }
    }

    let blocking = false;
    for (const [id, hold] of this.shieldHold) {
      const player = this.state.players.get(id);
      if (!player || !targets.has(id)) continue;
      if (player.isConnected && player.isReady) hold.acted = true;
      if (hold.acted || now >= hold.deadline) continue;
      blocking = true;
    }
    if (blocking) this.armShieldHoldTimer();
    else if (this.shieldHoldTimer) {
      clearTimeout(this.shieldHoldTimer);
      this.shieldHoldTimer = null;
    }
    return blocking;
  }

  private markShieldHoldActed(sessionId: string) {
    const hold = this.shieldHold.get(sessionId);
    if (hold) hold.acted = true;
  }

  private armShieldHoldTimer() {
    let soonest = Infinity;
    for (const hold of this.shieldHold.values()) {
      if (!hold.acted && hold.deadline < soonest) soonest = hold.deadline;
    }
    if (!Number.isFinite(soonest)) return;
    if (this.shieldHoldTimer) clearTimeout(this.shieldHoldTimer);
    const delay = Math.max(0, soonest - Date.now());
    this.shieldHoldTimer = setTimeout(() => {
      this.shieldHoldTimer = null;
      this.checkAllReady();
    }, delay);
  }

  private clearShieldHolds() {
    this.shieldHold.clear();
    if (this.shieldHoldTimer) {
      clearTimeout(this.shieldHoldTimer);
      this.shieldHoldTimer = null;
    }
  }

  startWheelPhase(): boolean {
    if (this.matchOver) return false;
    const contestantIds = connectedPlayerIds(this.state.players);
    if (!hasEnoughConnectedPlayers(this.state.players)) {
      return false;
    }

    let gameType = GAME_TYPES[Math.floor(Math.random() * GAME_TYPES.length)];
    const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    const betting = this.roundWillBeBetting();

    // Enforce Category Restrictions
    if (category === "Rock Paper Scissors" || category === "Simon Says" || category === "Perfection") {
      if (gameType === "2v2") gameType = "1v1";
    } else if (category === "Hot Potato" && gameType === "2v2") {
      gameType = "1v1"; // Fallback from 2v2 for Hot Potato
    }

    // A betting round always plays Battle Royale, whoever the wheel drew.
    if (betting) gameType = "BR";

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

    // Chart readiness must not carry into the post-wheel Ready to Play step.
    // A Wild Card or Respin lock stays until its own timer clears it.
    this.clearReadyFlags();
    this.clearDrinkChains();
    this.clearShieldHolds();
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
              this.awardCard(p, "TURBO");
            }
          } catch(e) {}
        }
      });
    }

    this.state.selectedPlayers.clear();
    contestantIds.slice(0, requiredPlayers).forEach(id => this.state.selectedPlayers.push(id));
    this.lockBettingStakes();

    this.broadcast("SpinWheelEvent", {
      type: this.state.currentGameType,
      category: this.state.currentCategory,
      selectedPlayers: this.state.selectedPlayers.toArray()
    });
    return true;
  }

  forceWheelPhase(type: string, category: string, selectedPlayerIds: string[]): boolean {
    if (this.matchOver) return false;
    const betting = this.roundWillBeBetting();
    // A betting round ignores a requested 1v1 or 2v2 subset and plays everyone.
    const contestantIds = connectedPlayerIds(
      this.state.players,
      betting ? undefined : selectedPlayerIds,
    );
    if (!hasEnoughConnectedPlayers(this.state.players, contestantIds)) {
      return false;
    }

    // A Wild Card or dev spin also opens a fresh Ready to Play step.
    // The card lock stays until its own timer clears it.
    this.clearReadyFlags();
    this.clearDrinkChains();
    this.clearShieldHolds();
    this.state.phase = "wheel";
    this.state.currentGameType = betting ? "BR" : type;
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
              this.awardCard(p, "TURBO");
            }
          } catch(e) {}
        }
      });
    }

    this.state.selectedPlayers.clear();
    contestantIds.forEach(id => this.state.selectedPlayers.push(id));
    this.lockBettingStakes();

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
   * Games report who won, who drinks, and how much each contestant did.
   * A non-betting round uses dev's no-action helper, then +3 / +1 drink.
   * A betting round pays the pot instead of +3. Nobody acting refunds that pot.
   */
  applyActiveGameResult() {
    if (!this.activeGame) return;
    const result = this.activeGame.onEnd(this.state);
    if (this.roundWillBeBetting()) {
      this.state.isBettingRound = true;
      if (!this.bettingLocked) this.lockBettingStakes();
      this.settleBetting(result);
      return;
    }
    scoreGameResult(this.state, result);
  }

  startResolutionPhase() {
    this.isCardLocked = false;
    this.clearShieldHolds();
    this.state.phase = "resolution";
    // One increment, here only. Master and the earned-round lock both read
    // this as "resolution N has started" before cards are dealt.
    this.state.roundCount += 1;
    this.state.isBettingRound = isBettingRound(this.state.roundCount);

    // Double Points adds another +3 on top of the standard +3.
    // A settled betting round already replaced that +3 with the pot, so it
    // does not add a further +3. An unsettled resolution still doubles.
    if (!this.bettingSettled) {
      applyDoublePoints(this.state);
    }

    // Check if roundCount is a multiple of 3 to distribute cards
    if (this.state.roundCount > 0 && this.state.roundCount % 3 === 0) {
      this.distributeSpecialtyCards();
    }

    // Reset activeEffects for all players at end of round
    this.state.players.forEach(p => {
      p.activeEffects = "";
    });

    this.seedDrinkChains();
  }

  /**
   * Take min(3, points) from each connected contestant. Called once when the
   * betting round's wheel first starts. A respin or wild-card replacement
   * does not take the stake again. Points leave `score` immediately so the
   * pot and the scores stay consistent during the round.
   */
  private lockBettingStakes(): void {
    const round = this.displayedRoundNumber();
    if (!isBettingRound(round) || this.bettingLocked) return;
    this.state.isBettingRound = true;

    const ids: string[] = [];
    const wagers: BettingWagerView[] = [];
    let pot = 0;
    this.bettingStakes.clear();
    this.state.selectedPlayers.forEach((id) => {
      const player = this.state.players.get(id);
      if (!player || !player.isConnected) return;
      const wager = wagerForPoints(player.score);
      player.score -= wager;
      player.betWager = wager;
      player.betPayout = 0;
      player.betNet = -wager;
      player.betRank = 0;
      pot += wager;
      ids.push(id);
      this.bettingStakes.set(id, wager);
      wagers.push({ playerId: id, name: player.name, wager });
    });

    this.bettingLocked = true;
    this.bettingSettled = false;
    this.bettingPlayerIds = ids;
    this.state.bettingPot = pot;
    this.state.bettingRefunded = false;

    const payload: BettingRoundPayload = {
      roundCount: round,
      pot,
      mode: "BR",
      wagers,
    };
    this.broadcast(BETTING_ROUND_EVENT, payload);
  }

  /**
   * Pay the pot from the mini-game's placement, or return every wager when
   * nobody acted. `applyNoActionRound` drops a reported win when every
   * action score is 0, including Lumber Cut at 0 pairs and a Turbo point on
   * a blank Math or Trivia board. Drinks still apply. There is no +3.
   */
  private settleBetting(result: GameResult): void {
    if (this.bettingSettled) return;
    this.bettingSettled = true;
    const resolved = applyNoActionRound(this.state, result);
    const seated = this.bettingPlayerIds.filter((id) => this.state.players.has(id));

    if (isNoActionResult(resolved)) {
      const placements = standingsForPlayers(seated, resolved, this.state.lastGameResult);
      this.refundSeatedStakes("no-action", false, this.competitionRanks(placements));
      for (const id of seated) {
        const player = this.state.players.get(id);
        if (player) player.drinks += 1;
      }
      return;
    }

    const placements = standingsForPlayers(seated, resolved, this.state.lastGameResult);
    const seatedStake = seated.reduce((sum, id) => sum + (this.bettingStakes.get(id) ?? 0), 0);
    // A scored round still pays by rank when every remaining stake is 0.
    // The pot is only what a leaver left. Plain rank weights give the winner
    // the biggest share. A refund is only for no-action or an abort.
    const stakes: Record<string, number> = {};
    for (const id of seated) stakes[id] = this.bettingStakes.get(id) ?? 0;
    const shares = seatedStake === 0
      ? splitPot(placements, this.state.bettingPot)
      : splitPot(placements, this.state.bettingPot, stakes);
    this.applyBettingDrinks(placements, resolved);

    const payouts: BettingPayoutView[] = [];
    for (const share of shares) {
      const player = this.state.players.get(share.playerId);
      if (!player) continue;
      const wager = this.bettingStakes.get(share.playerId) ?? player.betWager;
      player.score += share.payout;
      player.betPayout = share.payout;
      player.betNet = share.payout - wager;
      player.betRank = share.rank;
      payouts.push({
        playerId: share.playerId,
        name: player.name,
        wager,
        payout: share.payout,
        net: player.betNet,
        rank: share.rank,
      });
    }
    this.state.bettingRefunded = false;
    this.broadcastBettingPayout("payout", false, payouts);
  }

  /**
   * Battle Royale drinks: everyone tied for the top placement is 1st and does
   * not drink. Rock Paper Scissors keeps the game's own loser list. A full
   * free-for-all RPS format is still an open product question.
   */
  private applyBettingDrinks(placements: Placement[], resolved: GameResult): void {
    if (this.state.currentCategory === "Rock Paper Scissors") {
      applyDrinks(this.state, resolved);
      return;
    }
    let top = Number.NEGATIVE_INFINITY;
    for (const placement of placements) {
      if (placement.standing > top) top = placement.standing;
    }
    for (const placement of placements) {
      if (placement.standing === top) continue;
      const player = this.state.players.get(placement.playerId);
      if (player) player.drinks += 1;
    }
  }

  /**
   * Give the pot back to players who still hold a seat, including grace.
   * Each gets their own stake, plus a largest-remainder share of whatever
   * seats that left for good had staked. That share is proportional to the
   * stake still in the room. If nobody remaining staked, the leavers' stakes
   * are split equally and leftover points follow selection order.
   * The leaver is not paid. The payouts add up to the original pot.
   * `ranks` is the competition place when this refund still has a board.
   */
  private refundSeatedStakes(
    reason: BettingPayoutReason,
    clearWager: boolean,
    ranks?: ReadonlyMap<string, number>,
  ): void {
    const seated: Array<{ id: string; player: Player; wager: number; order: number }> = [];
    let leaverPot = 0;
    let order = 0;
    for (const [id, wager] of this.bettingStakes) {
      const player = this.state.players.get(id);
      if (!player) {
        leaverPot += wager;
        continue;
      }
      seated.push({ id, player, wager, order });
      order += 1;
    }

    const bonus = new Map<string, number>();
    const seatedStake = seated.reduce((sum, seat) => sum + seat.wager, 0);
    if (leaverPot > 0 && seated.length > 0 && seatedStake === 0) {
      const base = Math.floor(leaverPot / seated.length);
      let leftover = leaverPot - base * seated.length;
      for (const seat of seated) {
        const extra = leftover > 0 ? 1 : 0;
        if (leftover > 0) leftover -= 1;
        bonus.set(seat.id, base + extra);
      }
    } else if (leaverPot > 0 && seatedStake > 0) {
      const rows = seated.map((seat) => {
        const numerator = leaverPot * seat.wager;
        return {
          ...seat,
          floor: Math.floor(numerator / seatedStake),
          remainder: numerator % seatedStake,
        };
      });
      let leftover = leaverPot - rows.reduce((sum, row) => sum + row.floor, 0);
      const byRemainder = [...rows].sort((a, b) => {
        if (a.remainder !== b.remainder) return b.remainder - a.remainder;
        return a.order - b.order;
      });
      for (const row of byRemainder) {
        if (leftover <= 0) break;
        if (row.wager === 0) continue;
        bonus.set(row.id, (bonus.get(row.id) ?? 0) + row.floor + 1);
        leftover -= 1;
      }
      for (const row of rows) {
        if (!bonus.has(row.id)) bonus.set(row.id, row.floor);
      }
    }

    const payouts: BettingPayoutView[] = [];
    let returned = 0;
    for (const seat of seated) {
      const payout = seat.wager + (bonus.get(seat.id) ?? 0);
      const rank = ranks?.get(seat.id) ?? 0;
      seat.player.score += payout;
      seat.player.betPayout = payout;
      seat.player.betNet = payout - seat.wager;
      seat.player.betRank = rank;
      if (clearWager) {
        seat.player.betWager = 0;
        seat.player.betPayout = 0;
        seat.player.betNet = 0;
      }
      returned += payout;
      payouts.push({
        playerId: seat.id,
        name: seat.player.name,
        wager: seat.wager,
        payout,
        net: payout - seat.wager,
        rank,
      });
    }
    this.state.bettingPot = returned;
    this.state.bettingRefunded = reason === "no-action";
    this.broadcastBettingPayout(reason, true, payouts);
  }

  /** Competition place from the same rank weights a payout uses. Pot size does not change the place. */
  private competitionRanks(placements: Placement[]): Map<string, number> {
    const ranks = new Map<string, number>();
    for (const share of splitPot(placements, 0)) ranks.set(share.playerId, share.rank);
    return ranks;
  }

  private refundTrackedStakes(reason: Extract<BettingPayoutReason, "aborted" | "unresolved">): void {
    this.refundSeatedStakes(reason, true);
    this.state.bettingPot = 0;
    this.state.bettingRefunded = false;
  }

  /**
   * Abort puts the room back on the same round. An unsettled pot is returned
   * to whoever still has a seat. A pot that already settled stays in the
   * scores, and the replay locks a new stake from those scores. Neither path
   * pays the old result again.
   */
  private resetBettingAfterAbort(): void {
    if (this.bettingLocked && !this.bettingSettled) {
      this.refundTrackedStakes("aborted");
    }
    this.bettingLocked = false;
    this.bettingSettled = false;
    this.bettingPlayerIds = [];
    this.bettingStakes.clear();
    this.resetBettingDisplay();
  }

  private broadcastBettingPayout(
    reason: BettingPayoutReason,
    refunded: boolean,
    payouts: BettingPayoutView[],
  ): void {
    const payload: BettingPayoutPayload = {
      roundCount: this.displayedRoundNumber(),
      pot: this.state.bettingPot,
      refunded,
      reason,
      payouts,
    };
    this.broadcast(BETTING_PAYOUT_EVENT, payload);
  }

  /** Clear the pot display. Does not move points. */
  private resetBettingDisplay(): void {
    this.state.bettingPot = 0;
    this.state.bettingRefunded = false;
    this.state.players.forEach((player) => {
      player.betWager = 0;
      player.betPayout = 0;
      player.betNet = 0;
      player.betRank = 0;
    });
  }
}
