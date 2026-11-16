/**
 * Start gate for a party match.
 *
 * Only players with `isConnected === true` count toward starting a match.
 * A seat in the reconnect grace window still occupies a roster slot (see
 * LobbyRoom.heldSeatCount) but is not connected, so it does not count here.
 * Ready to Spin and every other start path should call
 * `hasEnoughConnectedPlayers` before leaving the lobby or spinning the wheel.
 */
export const MAX_ROOM_PLAYERS = 12;
export const MIN_CONNECTED_PLAYERS = 2;

export interface ConnectedPlayerLike {
  isConnected: boolean;
}

export interface PlayerDirectory {
  forEach(callback: (player: ConnectedPlayerLike, sessionId: string) => void): void;
}

export function connectedPlayerIds(players: PlayerDirectory, onlyIds?: readonly string[]): string[] {
  const allowed = onlyIds ? new Set(onlyIds) : null;
  const ids: string[] = [];
  players.forEach((player, sessionId) => {
    if (!player.isConnected) return;
    if (allowed && !allowed.has(sessionId)) return;
    ids.push(sessionId);
  });
  return ids;
}

export function countConnectedPlayers(players: PlayerDirectory, onlyIds?: readonly string[]): number {
  return connectedPlayerIds(players, onlyIds).length;
}

/** True when at least `MIN_CONNECTED_PLAYERS` connected players are available. */
export function hasEnoughConnectedPlayers(players: PlayerDirectory, onlyIds?: readonly string[]): boolean {
  return countConnectedPlayers(players, onlyIds) >= MIN_CONNECTED_PLAYERS;
}
