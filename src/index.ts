import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "http";
import express from "express";
import cors from "cors";
import { LobbyRoom } from "./rooms/LobbyRoom";

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server
  })
});

gameServer.define("lobby", LobbyRoom);

const port = Number(process.env.PORT) || 2567;
gameServer.listen(port).then(() => {
  console.log(`[GameServer] Listening on Port: ${port}`);
});
