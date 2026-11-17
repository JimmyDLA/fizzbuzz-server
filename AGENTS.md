# Agent notes

Pull requests target `dev`, never `master`.

## Layout

- `src/` — Colyseus server. `src/index.ts` boots HTTP and the game server.
- `src/games/` — mini-games. Each file implements `IMiniGame`.
- `src/rooms/` — lobby, practice, scoring, betting, match length, room codes, errors.
- `src/rooms/schema/LobbyState.ts` — synchronized Colyseus schema.
- `tests/` — `node:test` suites (`*.test.ts`) and `tests/helpers.ts`.
- `package.json`, `package-lock.json` — npm scripts and the lockfile.
- `tsconfig.json` — strict TypeScript; includes `src` and `tests`.
- `eslint.config.mjs` — flat ESLint config (typescript-eslint).
- `.github/workflows/ci.yml` — typecheck, lint, and test on `dev`.
- `README.md` — product overview. `.gitignore` — generated and local files.

## Install

```bash
npm ci
```

## Typecheck

```bash
npx tsc --noEmit
```

## Lint

```bash
npm run lint
```

## Test

```bash
npm test
```

That runs `node -r ts-node/register --test tests/**/*.test.ts`.

## Dev server

```bash
npm start
```

`PORT` sets the listen port (`src/index.ts`). It defaults to `2567`. Pick another port when a dev server is already running.

Dev tools (`dev_start_wheel`, `dev_award_card`) are on only when `ALLOW_DEV_TOOLS=1` and `NODE_ENV` is `development` or `test`. For a test server:

```bash
ALLOW_DEV_TOOLS=1 NODE_ENV=test PORT=2568 npm start
```

No other environment variables gate dev tools.
