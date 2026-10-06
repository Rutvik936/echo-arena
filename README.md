# Echo Arena

A two-player real-time browser fighting game prototype where each player's recent actions return as temporary Echo fighters.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`, create a room, then open the same URL in another browser/device and join with the room code.

## Current gameplay

- Private five-character room codes
- Two-player WebSocket synchronization
- Server-controlled movement, attacks, hit detection, health, timer, winner state, and rematch
- Countdown before the fight
- Punch, kick, block, jump, and movement
- Echoes spawn on a predictable timer and replay roughly the last nine seconds of each player's inputs
- Desktop keyboard controls and mobile touch controls

## Controls

- Move: `A` / `D` or arrow keys
- Jump: `W`, up arrow, or space
- Punch: `J`
- Kick: `K`
- Block: `L` or shift

## Deploy

This app is dependency-free and can run on any public Node host that supports WebSockets.

Use:

```bash
npm start
```

Set the public port with the host's `PORT` environment variable. The server automatically uses the same origin for WebSocket connections, so no client configuration is needed after deployment.
