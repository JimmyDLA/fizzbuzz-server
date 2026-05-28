# FizzBuzz Server 🍻🎮

The real-time multiplayer backend for **FizzBuzz**, built with [Colyseus](https://colyseus.io/) and Node.js.

FizzBuzz is an interactive multiplayer party game where players connect to a shared lobby, spin the wheel to select a mini-game, and battle it out in 1v1, 2v2, or Battle Royale modes. Winners earn points to climb the leaderboard, while losers are penalized with drinks!

## Features

- **Real-time State Synchronization:** Powered by Colyseus for ultra-low latency multiplayer game loops.
- **Dynamic Game Modes:** Supports 1v1, 2v2 Team Battles, and Free-for-all Battle Royale (BR).
- **Practice Mode:** A dedicated, consequence-free practice state that allows players to try out games together before putting drinks on the line.
- **8 Interactive Mini-Games:**
  - 🏎️ **Tapping Race**: Mash the button as fast as possible.
  - 🧠 **Trivia**: Answer general knowledge questions correctly.
  - ➕ **Math Problem**: Solve rapid-fire math equations.
  - 🌪️ **Cyclone**: Stop the light exactly on the bullseye.
  - 🎈 **Balloon Inflate**: Pump the balloon until it pops—but don't wait too long!
  - 🪓 **Lumber Cut**: Coordinate with a partner to saw logs (2v2 focus).
  - 🥔 **Hot Potato**: Pass the bomb before it explodes (1v1 focus).
  - ✂️ **Rock Paper Scissors**: A classic showdown (1v1 focus).
- **Automated Leaderboards:** Computes individual and team tallies instantly at the end of each round.

## Tech Stack

- **Framework:** [Colyseus](https://colyseus.io/)
- **Runtime:** Node.js
- **Language:** TypeScript
- **Client Sync:** Native Colyseus `@type` schema definitions

## Getting Started

### Prerequisites

- Node.js (v16 or higher recommended)
- npm or yarn

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/fizzbuzz-server.git
   cd fizzbuzz-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```
   The server will typically start on `http://localhost:2567`.

## Architecture Overview

- **`src/rooms/LobbyRoom.ts`**: The core room where all players connect. Handles the wheel spinning, player readiness, mode selections, and phase transitions (chart -> wheel -> ready -> playing -> resolution).
- **`src/rooms/schema/LobbyState.ts`**: The synchronized schema that tracks the players, scores, active game phase, and practice states.
- **`src/games/`**: Contains the isolated logic for each of the 8 mini-games, implementing the `IMiniGame` interface for consistent `onInit`, `onMessage`, `onTick`, and `onEnd` lifecycle hooks.

## License

MIT
