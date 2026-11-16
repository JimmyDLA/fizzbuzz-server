import { ErrorCode, ServerError, matchMaker } from "@colyseus/core";

/** Inclusive bounds. Docs ask for a 4-digit code; 0000–0999 stay unused. */
export const ROOM_CODE_MIN = 1000;
export const ROOM_CODE_MAX = 9999;
export const ROOM_CODE_SPAN = ROOM_CODE_MAX - ROOM_CODE_MIN + 1;

/**
 * Codes claimed by a create that the matchmaker does not list yet.
 * Colyseus writes the listing only after onCreate resolves, so two creates
 * that both ask the matchmaker can otherwise pick the same code.
 * Released from onDispose, once the room is gone and the code may be reused.
 */
const reservedCodes = new Set<string>();

let drawRoomCode = drawRandomRoomCode;

export function isCanonicalRoomCode(code: string): boolean {
  return /^[1-9][0-9]{3}$/.test(code);
}

export function formatRoomCode(roll: number): string {
  return Math.floor(ROOM_CODE_MIN + roll * ROOM_CODE_SPAN).toString();
}

function drawRandomRoomCode(): string {
  return formatRoomCode(Math.random());
}

export interface RoomCodeLookup {
  /** True when any live room already owns this id. */
  isLive(code: string): boolean | Promise<boolean>;
}

/**
 * practice_room and lobby share one matchmaker id space: listings are keyed
 * by roomId, not by room name. A practice room that holds a 4-digit id blocks
 * that party code. Default practice ids are 9-character nanoids, so they do
 * not normally land in 1000–9999, but the check still covers them.
 */
async function isListedInMatchmaker(code: string): Promise<boolean> {
  const existing = await matchMaker.getRoomById(code);
  return existing != null;
}

const matchmakerLookup: RoomCodeLookup = {
  isLive: isListedInMatchmaker,
};

function nextUntried(tried: Set<string>, after: number): string | null {
  for (let step = 1; step <= ROOM_CODE_SPAN; step++) {
    const n = ((after - ROOM_CODE_MIN + step) % ROOM_CODE_SPAN) + ROOM_CODE_MIN;
    const candidate = String(n);
    if (!tried.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Claim a free code in 1000–9999. Retries while the code is reserved on this
 * process or already listed for any live room. Throws when all 9000 are taken
 * so create fails instead of reusing a live code.
 */
export async function claimRoomCode(lookup: RoomCodeLookup = matchmakerLookup): Promise<string> {
  const tried = new Set<string>();

  while (tried.size < ROOM_CODE_SPAN) {
    let code = drawRoomCode();
    if (!isCanonicalRoomCode(code) || tried.has(code)) {
      const pivot = isCanonicalRoomCode(code) ? Number(code) : ROOM_CODE_MIN - 1;
      const next = nextUntried(tried, pivot);
      if (next === null) break;
      code = next;
    }

    tried.add(code);
    if (reservedCodes.has(code)) continue;

    // Reserve before the matchmaker read so a concurrent create cannot take it.
    reservedCodes.add(code);
    try {
      if (await lookup.isLive(code)) {
        reservedCodes.delete(code);
        continue;
      }
      return code;
    } catch (error) {
      reservedCodes.delete(code);
      throw error;
    }
  }

  throw new ServerError(
    ErrorCode.MATCHMAKE_UNHANDLED,
    "No room codes available. All codes from 1000 to 9999 are already in use.",
  );
}

export function releaseRoomCode(code: string): void {
  reservedCodes.delete(code);
}

/** Test hook. Pass null to restore Math.random. */
export function useRoomCodeDrawForTests(draw: (() => string) | null): void {
  drawRoomCode = draw ?? drawRandomRoomCode;
}

export function reserveRoomCodeForTests(code: string): void {
  if (!isCanonicalRoomCode(code)) {
    throw new Error(`invalid room code ${code}`);
  }
  reservedCodes.add(code);
}

export function clearReservedRoomCodesForTests(): void {
  reservedCodes.clear();
}
