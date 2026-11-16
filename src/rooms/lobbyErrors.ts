import { ErrorCode, ServerError, matchMaker } from "@colyseus/core";
import { MAX_ROOM_PLAYERS } from "./connectedPlayers";

/**
 * Stable codes the app can branch on. Join failures travel as a Colyseus
 * matchmake error string (`CODE: human text`) because that path only carries
 * a string. In-room failures are sent as `LobbyError` payloads.
 */
export const LobbyErrorCode = {
  ROOM_FULL: "ROOM_FULL",
  NOT_ENOUGH_PLAYERS: "NOT_ENOUGH_PLAYERS",
  NOT_HOST: "NOT_HOST",
  INVALID_ROUNDS: "INVALID_ROUNDS",
  ROUNDS_LOCKED: "ROUNDS_LOCKED",
} as const;

export type LobbyErrorCode = (typeof LobbyErrorCode)[keyof typeof LobbyErrorCode];

export interface LobbyErrorPayload {
  code: LobbyErrorCode;
  message: string;
}

/** Room message the seated client receives when a start is blocked. */
export const LOBBY_ERROR_EVENT = "LobbyError";

export function roomFullError(): LobbyErrorPayload {
  return {
    code: LobbyErrorCode.ROOM_FULL,
    message: `This room is full (${MAX_ROOM_PLAYERS} players max).`,
  };
}

export function notEnoughPlayersError(): LobbyErrorPayload {
  return {
    code: LobbyErrorCode.NOT_ENOUGH_PLAYERS,
    message: "At least 2 players are required to start.",
  };
}

export function notHostError(): LobbyErrorPayload {
  return {
    code: LobbyErrorCode.NOT_HOST,
    message: "Only the host can set the match length.",
  };
}

export function invalidRoundsError(): LobbyErrorPayload {
  return {
    code: LobbyErrorCode.INVALID_ROUNDS,
    message: "Rounds must be 10, 15, 20, 30, 40, or 50.",
  };
}

export function roundsLockedError(): LobbyErrorPayload {
  return {
    code: LobbyErrorCode.ROUNDS_LOCKED,
    message: "Match length can only be changed in the lobby.",
  };
}

export function formatLobbyError(error: LobbyErrorPayload): string {
  return `${error.code}: ${error.message}`;
}

export function parseLobbyError(raw: string): LobbyErrorPayload | null {
  const separator = raw.indexOf(": ");
  if (separator <= 0) return null;
  const code = raw.slice(0, separator);
  const message = raw.slice(separator + 2);
  if (!Object.values(LobbyErrorCode).includes(code as LobbyErrorCode)) {
    return null;
  }
  return { code: code as LobbyErrorCode, message };
}

let installed = false;

/**
 * Colyseus rejects the player past `maxClients` with "room is locked" before
 * room code runs. Rewrite that lobby join failure so the app can recognize it.
 * Practice rooms and an explicitly locked room that is not full are unchanged.
 */
export function installLobbyFullRoomError(): void {
  if (installed) return;
  installed = true;

  const controller = matchMaker.controller;
  const original = controller.invokeMethod.bind(controller);
  controller.invokeMethod = async function (method, roomName, clientOptions, authOptions) {
    try {
      return await original(method, roomName, clientOptions, authOptions);
    } catch (error) {
      throw await rewriteFullLobbyJoinError(method, roomName, error);
    }
  };
}

async function rewriteFullLobbyJoinError(method: string, roomName: string, error: unknown): Promise<unknown> {
  if (method !== "joinById" || !(error instanceof Error)) return error;

  const fullRoom = error.message.includes("is locked") || error.message.includes("is already full");
  if (!fullRoom) return error;

  let listing: { name?: string; clients?: number; maxClients?: number } | undefined;
  try {
    listing = await matchMaker.getRoomById(roomName);
  } catch {
    return error;
  }

  if (listing?.name !== "lobby") return error;

  const clients = listing.clients ?? 0;
  const maxClients = listing.maxClients ?? 0;
  const atCapacity = maxClients === MAX_ROOM_PLAYERS && clients >= maxClients;
  // "already full" is only thrown once the live client cap is hit. A locked
  // lobby that still has open seats keeps Colyseus's own message.
  if (!atCapacity && !error.message.includes("is already full")) return error;

  return new ServerError(ErrorCode.MATCHMAKE_INVALID_ROOM_ID, formatLobbyError(roomFullError()));
}

installLobbyFullRoomError();
