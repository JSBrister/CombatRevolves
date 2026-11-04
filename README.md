# Combat Revolves

A physics-joke FPS on a small, fast-spinning ring habitat (R = 100 m, ω = √(g/R) ≈ 0.313 rad/s, 20 s period).
There is no gravity anywhere. Everything you feel is centrifugal or Coriolis force, and the plasma is slow enough that you can watch it curve.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest physics/determinism suite
npm run headless   # runs the sim with 4 bots in Node, no DOM/three.js
npx tsc -p src/sim # proves the sim compiles without DOM types
```

**Play online:** this repo builds and deploys itself to GitHub Pages on every push to `main` (enable it under Settings → Pages → Source: GitHub Actions).

**Modes:** *Campaign* (fixed levels: kill every enemy to clear it, no respawns, enemies don't hurt each other) and
*Debug sandbox* (free-for-all with bots and respawns). Levels are rings of different sizes for now.

**Controls:** WASD move · Shift toggle sprint (on by default) · Space jump (hold in the air with a jetpack) · mouse look ·
left click fire · right click show trajectory · 1–5 weapons you own · wheel next weapon · G sticky grenade · F bouncing grenade
(hold to aim, release to throw) · walk over items to pick them up · Esc pause.
The debug panel (ring size 10–5000 m, forces, movement, every weapon's stats, time scale, inertial-frame overlay, free-fly camera,
hover gun, bots) only appears while paused.

## Weapons and items

| Slot | Weapon | Notes |
|---|---|---|
| 1 | Plasma rifle | Automatic, overheats. Starting weapon. |
| 2 | Plasma pistol | Tap to fire, hold to overcharge (strips shields). Starting weapon. |
| 3 | Red plasma rifle | Faster bolts, overheats sooner. |
| 4 | Fuel rod launcher | 3-round magazine plus 9 spares; reload with R (or automatically). Slow bolt that explodes on impact with its own blast settings. |
| 5 | Plasma bolt cannon | The "sniper": one fast (65 m/s), hard-hitting magenta bolt, then it overheats for ~1 s. |
| 6 | Laconic Laser | Superweapon: hold to charge (1.2 s), then it streams very fast red bolts for 0.5 s. You move and aim slowly the whole time. Most of a stream kills. |
| 7 | Grav Mallet | Melee weapon: a wide swing (3.2 m reach) that hits everyone in front of you for 90 and a 28 m/s shove. |
| — | Hover gun | Debug only: fires a bolt at rest in the inertial frame. |

Every hit gives a small kick along the bolt's path (tunable per weapon). **Q** is a melee shove with any weapon: short
range, a lot of knockback. Campaign enemies never run out of ammo but still have to reload.

Items float at fixed spots (respawning after 25 s): health, sticky and bouncing grenade refills (max 4 of each), the
special weapons, and a jetpack (about 4 s of thrust). Picking up something you already have refills it; if it would do
nothing, it stays put. When a player dies they drop their special weapons, jetpack and grenades, which last 30 s.

## Where to tweak things

| File | What's in it |
|---|---|
| `src/sim/tuning.ts` | **All default numbers**: ring, physics, movement, grenades, explosions, items (`defaultConfig`), every weapon's stats (`defaultWeapons`), and the campaign enemy types (`ENEMY_TYPES`). Commented. |
| `src/sim/levels.ts` | **Every level**: campaign layouts (ring size, seed, where each enemy stands) and sandbox rings. Add a level by adding an entry. |
| In game | Pause (Esc): the debug panel changes any of the above live (not saved), and *Give* hands you weapons and items. |

## Layout

| Path | What |
|---|---|
| `src/sim/` | Headless authoritative simulation: plain data, `step(state, inputs, tick)`, no DOM or three.js |
| `src/sim/physics.ts` | Rotating-frame forces, Strang/Boris-style integrator, exact analytic free flight |
| `src/sim/level.ts` | Level SDF (hull, rim walls, local-frame boxes) and swept sphere tracing |
| `src/sim/step.ts` | Players, weapons, projectiles, sticky grenades, explosions, damage and respawn |
| `src/sim/serialize.ts` | `snapshot`/`restore` and a compact lossless binary encoder |
| `src/sim/bots.ts` | Scripted bots and campaign enemy AI: pure `state → InputCmd` |
| `src/sim/levels.ts`, `src/sim/tuning.ts` | Level definitions and all tunable defaults (see above) |
| `src/sim/predict.ts` | Trajectory preview using the real physics |
| `src/client/` | three.js renderer, interpolation, HUD, lil-gui, WebAudio placeholder sounds |
| `tests/sim.test.ts` | The correctness spec |

## Physics and architecture decisions

- **Rotating frame everywhere.** The level is static, and up is −radial. The stars, sun, planet and inertial trails live in a group rotated by −`frameAngle`. `frameAngle` is accumulated in sim state each tick, so it equals ω·t when ω is constant and stays continuous if you change g.
- **Integrator:** symmetric splitting D·K·C·X·C·K·D (drag, centrifugal kick, *exact* Coriolis rotation, drift). Coriolis acts like a magnetic force, so this is the rotating-frame Boris pusher. It is time-reversible and 2nd-order, the Coriolis step never does work, and the Jacobi integral oscillates with no secular drift. RK4 is 4th-order but drifts slowly in energy and costs 4× the force evaluations.
- **Exact projectiles:** with drag = 0 (and both forces on), bolts and grenades use the analytic inertial straight line, rotated back by −ωt. They apply it from the current state each tick, which is mathematically identical to applying it once from launch, and the test checks the two agree to 1e-9 m. Hits are swept per tick with SDF sphere tracing, so nothing tunnels.
- **Contacts:** a resting body gets an explicit support (normal) force that cancels the into-surface part of the *total* fictitious force (centrifugal + Coriolis). A body at rest therefore stays *exactly* at rest, and a player running antispinward stays on the floor (cancelling only the centrifugal part used to let Coriolis lift them off every few ticks, which broke jumping). Push-outs compensate kinetic energy so the Jacobi integral survives bounces.
- **Apparent weight** on the HUD is measured from what the contact actually did each tick, so it includes the floor's curvature: running at speed v you weigh (ωR ± v)²/R.
- **Jumping** works for 0.12 s after leaving a surface ("coyote time"). In the air you get a little control, but only up to walk speed.
- **Weapons are data:** every stat lives in `config.weapons` (per weapon), so the debug panel can tune them live and the state still serializes.
- **Impact damage:** hitting a surface faster than 22 m/s (normal component) hurts; a knock into a wall credits whoever hit you.
- **Levels** are data (`levels.ts`): a ring size and seed fix the layout; enemies are placed by angle and z, or on a ramp's lookout platform; a placement that lands inside cover is nudged clear. `level.shape` is the seam for other kinds of world (only `'ring'` exists): the collision shape, force field and renderer switch on it.
- **Campaign rules:** teams (you vs enemies) with friendly fire off, no respawns, won when every enemy is dead, lost when you die. Enemy types differ in size (their hitbox scales too), colour, health, speed, weapon, range, accuracy and behaviour (chase, strafe, hold).
- **Ring size** scales the map: rim walls are capped at 40% of the radius, ramps and cover shrink on small rings.
- **Obstacle boxes** are axis-aligned in the *local frame* of their ring angle, not in world XYZ. World-aligned boxes would sit crooked on a curved floor.
- **Inputs:** players without a command for a tick repeat their last one, as a server would. Edge-triggered actions (jump, pistol tap, grenade release) use `prevButtons` stored in state, so they replay exactly.
- **Snapshots** use the binary encoder, not JSON, because JSON turns −0 into 0. That can flip an `atan2` branch and break bit-exact replay.
- **Rim walls** vary in height per angular sector (full 15 m, 4 m, or a 1 m curb with orange tops). The SDF evaluates the point's own sector plus any taller neighbours, using the exact distance to the neighbour's edge. Past a curb there is only space: anything more than `fallKillDistance` (default 25 m) off the ring band is dead.
- **Ramps:** one tilted slab each (boxes can tilt about the ring's axis), up to an 11 m lookout where you weigh about 0.88 g. The floor curves up away from a straight slab, so its ends are raised to match exactly: the low end meets the floor and the top meets the platform flush. Alternate ramps climb spinward and antispinward.
- **Shot speeds** are high enough (80–200 m/s) that bolts barely curve at close range: over distance D a bolt sags about g·D²/2v² and Coriolis bends it up to ω·D²/v, so ~0.5 m over 10 m for the rifle. Across the ring they still curve plenty.
- **Enemy aim:** each enemy type has an `aimSkill` (0–1). 0 aims straight at you; 1 runs the real physics on its own shot (launch rule, spin, your current velocity) and Newton-iterates yaw/pitch on the miss. The aim is blended between the two by skill, plus random wobble (`aimError`).
- **Mesas:** low (3.5 m) platforms with ramps, about one per 80 m of ring, plus denser cover, so big rings aren't empty.
- **Ammo:** `magSize` rounds in the magazine, `ammoMax` spares; reloading takes `reloadTime`. Heat-based weapons have `magSize` 0.
- **Bouncing grenades** (yellow) share one sub-stepped sphere mover with the props and with their own trajectory preview. Their fuse starts at the throw. They bounce off players and props relative to the target's velocity.
- **Owner self-hits:** a projectile is `armed` against its owner once it has left the owner's capsule. The test fires a bolt antispinward at the local rim speed, and it hits the shooter in the back ≈ 2π/ω later.

## Known limitations / next steps

- No networking yet. The pieces are in place: inputs are per tick, the state is serializable, and restore-and-replay is exact.
- Player-vs-player and prop collisions are simple positional pushes. There is no rigid-body rotation, and prop rolling is visual only.
- Explosions ignore line of sight.
- Bots aim in a straight line and don't compensate for Coriolis. That is on purpose.
- Pickups are floating items, not physics objects. Dropped items hang where they land, 0.7 m above the floor.
