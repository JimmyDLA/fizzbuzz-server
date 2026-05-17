import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "http";
import express from "express";
import cors from "cors";
import { LobbyRoom } from "./rooms/LobbyRoom";
import { PracticeRoom } from "./rooms/PracticeRoom";

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server,
    pingInterval: 5000, // 5 seconds
    pingMaxRetries: 18, // 5s * 18 = 90 seconds before dropping unresponsive client
  })
});

gameServer.define("lobby", LobbyRoom);
gameServer.define("practice_room", PracticeRoom);

const port = Number(process.env.PORT) || 2567;
gameServer.listen(port).then(() => {
  console.log(`[GameServer] Listening on Port: ${port}`);
});
