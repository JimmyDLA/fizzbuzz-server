import { Client } from "@colyseus/core";
import { LobbyState } from "../rooms/schema/LobbyState";

export interface IMiniGame {
  onInit(state: LobbyState): void;
  onMessage(client: Client, message: any, state: LobbyState): void;
  onTick(state: LobbyState): void;
  onEnd(state: LobbyState): void;
}
