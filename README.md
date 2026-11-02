# Combat Revolves

A physics-joke FPS on a small, fast-spinning ring habitat (R = 100 m, ω = √(g/R) ≈ 0.313 rad/s, 20 s period).
There is no gravity anywhere. Everything you feel is centrifugal or Coriolis force, and the plasma is slow enough that you can watch it curve.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest physics/determinism suite (21 tests)
npm run headless   # runs the sim with 4 bots in Node, no DOM/three.js
npx tsc -p src/sim # proves the sim compiles without DOM types
```

**Controls:** WASD, Shift sprint, Space jump, mouse look · LMB fire (pistol: hold to overcharge) · RMB trajectory preview ·
G hold/release to throw a sticky grenade · 1/2/3 rifle/pistol/hover gun · I inertial overlay · V free-fly camera · T slow-mo · P pause · B add bot · H help.

## Layout

| Path | What |
|---|---|
| `src/sim/` | Headless authoritative simulation: plain data, `step(state, inputs, tick)`, no DOM or three.js |
| `src/sim/physics.ts` | Rotating-frame forces, Strang/Boris-style integrator, exact analytic free flight |
| `src/sim/level.ts` | Level SDF (hull, rim walls, local-frame boxes) and swept sphere tracing |
| `src/sim/step.ts` | Players, weapons, projectiles, sticky grenades, explosions, damage and respawn |
| `src/sim/serialize.ts` | `snapshot`/`restore` and a compact lossless binary encoder |
| `src/sim/bots.ts` | Scripted bots: pure `state → InputCmd` |
| `src/sim/predict.ts` | Trajectory preview using the real physics |
| `src/client/` | three.js renderer, interpolation, HUD, lil-gui, WebAudio placeholder sounds |
| `tests/sim.test.ts` | The correctness spec |

## Physics and architecture decisions

- **Rotating frame everywhere.** The level is static, and up is −radial. The stars, sun, planet and inertial trails live in a group rotated by −`frameAngle`. `frameAngle` is accumulated in sim state each tick, so it equals ω·t when ω is constant and stays continuous if you change g.
- **Integrator:** symmetric splitting D·K·C·X·C·K·D (drag, centrifugal kick, *exact* Coriolis rotation, drift). Coriolis acts like a magnetic force, so this is the rotating-frame Boris pusher. It is time-reversible and 2nd-order, the Coriolis step never does work, and the Jacobi integral oscillates with no secular drift. RK4 is 4th-order but drifts slowly in energy and costs 4× the force evaluations.
- **Exact projectiles:** with drag = 0 (and both forces on), bolts and grenades use the analytic inertial straight line, rotated back by −ωt. They apply it from the current state each tick, which is mathematically identical to applying it once from launch, and the test checks the two agree to 1e-9 m. Hits are swept per tick with SDF sphere tracing, so nothing tunnels.
- **Contacts:** a resting body gets an explicit support (normal) force that cancels the into-surface part of the centrifugal force. A body at rest therefore stays *exactly* at rest, with no Coriolis creep from penetration jitter. Push-outs compensate kinetic energy so the Jacobi integral survives bounces.
- **Obstacle boxes** are axis-aligned in the *local frame* of their ring angle, not in world XYZ. World-aligned boxes would sit crooked on a curved floor.
- **Inputs:** players without a command for a tick repeat their last one, as a server would. Edge-triggered actions (jump, pistol tap, grenade release) use `prevButtons` stored in state, so they replay exactly.
- **Snapshots** use the binary encoder, not JSON, because JSON turns −0 into 0. That can flip an `atan2` branch and break bit-exact replay.
- **Owner self-hits:** a projectile is `armed` against its owner once it has left the owner's capsule. The test fires a bolt antispinward at the local rim speed, and it hits the shooter in the back ≈ 2π/ω later.

## Known limitations / next steps

- No networking yet. The pieces are in place: inputs are per tick, the state is serializable, and restore-and-replay is exact.
- Player-vs-player and prop collisions are simple positional pushes. There is no rigid-body rotation, and prop rolling is visual only.
- Explosions ignore line of sight.
- Bots aim in a straight line and don't compensate for Coriolis. That is on purpose.
