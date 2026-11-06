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
*Deathmatch* (free-for-all with bots and respawns; the debug panel is in the pause menu). Levels are rings of different sizes and widths (some with rolling hills, a bowl-shaped *sphere band*, or a planet's pull), plus *Earth* (flat ground, normal gravity, no spin: the reference for what everything should do) and *Shore Leave*, the last campaign level, also on Earth. (They come last in each list on purpose: the spin is the point.)

**Controls:** WASD move · Shift toggle sprint (on by default) · Space jump (hold in the air with a jetpack) · mouse look ·
left click fire · right click show trajectory · 1–9, 0, − and = weapons you own · wheel next weapon · G sticky grenade · F bouncing grenade
(hold to aim, release to throw) · R reload · Q melee · E get on/off a hover-bike · walk over items to pick them up · Tab scores · Esc pause.
The debug panel (ring size 10–5000 m, forces, movement, every weapon's stats, time scale, inertial-frame overlay, free-fly camera,
hover gun, bots) only appears while paused.

## Weapons and items

| Slot | Weapon | Notes |
|---|---|---|
| 1 | Plasma rifle | Automatic, overheats. Starting weapon. |
| 2 | Plasma pistol | Tap to fire, hold to overcharge (strips shields). The overcharged shot is a little faster than a tap and homes in a little on whoever was nearest your aim. Starting weapon. |
| 3 | Revolver | A normal gun, for comparison: 6 rounds of tiny, very fast (900 m/s) yellow-white bullets that hit hard. They barely curve, so you can see how much of the weirdness is just slow plasma. |
| 4 | Overclocked Plasma Rifle | Red: faster bolts and a faster rate of fire, hits as hard as the blue rifle, but overheats sooner. |
| 5 | Roulette Repeater | Fires fast, but every shot leaves at a random speed from 15 to 220 m/s, coloured from red (slow) to blue-white (fast). Watch the slow ones curve. |
| 6 | Scattergun | Ten slow pellets (55 m/s) sprayed within 7° of your aim. Brutal up close; further out the spin bends the spray apart. 6-round magazine. |
| 7 | Plasma bolt cannon | The "sniper": one fast (200 m/s), hard-hitting magenta bolt, then it overheats for ~1 s. |
| 8 | Fuel rod launcher | 3-round magazine plus 9 spares; reload with R (or automatically). Slow bolt that explodes on impact with its own blast settings. |
| 9 | Torch Rocket | A real rocket: leaves at 20 m/s, then its motor pushes it along its nose at 70 m/s² for 1.5 s. The nose starts where you aimed and keeps its direction relative to the stars, so in the ring's frame it slowly turns against the spin. Big blast. 2-round magazine. |
| 0 | Seeker Swarm | Hold for a stream of little homing rockets. Each locks onto an enemy within 20° of its nose in its first moments, and its motor burns for only 0.8 s. It steers by what it sees and knows nothing about the spin. So it corrects a near miss, but you still have to lead the shot and allow for the spin, and lobbing it high does nothing. Six hits in quick succession *supercombine*. |
| − | Laconic Laser | Superweapon: hold to charge (1.2 s), then it streams very fast red bolts for 0.5 s. You move and aim slowly the whole time. Most of a stream kills. |
| = | Grav Mallet | Melee weapon: a wide swing (3.2 m reach) that hits everything in the arc in front of you (shown briefly): 90 damage and a 28 m/s shove to people, a knock to bikes, and loose grenades get batted away (they're yours now). |
| — | Hover gun | Debug only: fires a bolt at rest in the inertial frame. |

Every hit gives a small kick along the bolt's path (tunable per weapon). A reload carries on if you switch weapons. **Q** is a melee shove with any weapon: short
range, a lot of knockback. Campaign enemies never run out of ammo but still have to reload.

Items float at fixed spots (respawning after 25 s): health, sticky and bouncing grenade refills (max 4 of each), the
special weapons, and a jetpack (about 4 s of thrust). Picking up something you already have refills it; if it would do
nothing, it stays put. When a player dies they drop their special weapons, jetpack and grenades, which last 30 s.

The deathmatch list groups the oversized levels (radius or half-width of 500 m or more) together under *Huge*, until the vehicles are better.

## Build a level

*Build a level* on the title screen gives you the level generator as a form:
- The shape: ring, sphere band, whole sphere, ridge, inside a torus, half-pipe, or the log.
- Size, width and gravity, the rim walls, and the floor (deck plating, grass, sand, snow or rock).
- What's on the floor: hills, mountains, bases, holes, an upper deck and O'Neill windows.
- The world: a changing spin, a planet's pull, air.
- Bots, bikes and a layout seed.

*Surprise me* rolls a random one. *Copy link* copies a URL that rebuilds the same level for anyone who opens it; only the settings that differ from the defaults go in it. The code is in `src/client/custom.ts`, and its output is an ordinary level definition.

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
| `src/sim/bots.ts` | Scripted bots and campaign enemy AI (aiming, cover, ramps): pure `state → InputCmd` |
| `src/sim/terrain.ts` | Floor height profile: hills and the sphere band |
| `src/sim/vehicles.ts` | Hover-bikes: riding, crashes, ramming, damage and respawn |
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
- **Earth** is a "ring" 100 km in radius with `spin: false` and real gravity (`gravity: 9.81`, pulling toward the floor) over a walled 120 m `arena`. Across the arena the floor curves by about 2 cm, so it's flat ground and every other system (collision, "up", spawns, bots) works unchanged. Tests check it behaves like Earth: drops fall straight down in √(2h/g), a 45° throw lands at v²/g, a jump peaks at v²/2g. The renderer draws only the arena and nearby ground, built around the arena centre: 100 km coordinates in single precision are only good to about a centimetre.
- **World settings** (size, g, spin, gravity, arena, width, walls, air) reset for every level; other debug-panel tweaks carry over.
- **Shadows:** one shadow-casting sun that follows the camera. On rings the sun is fixed relative to the stars, 40° off the axis, so in the ring's frame it circles once per spin: each spot gets a day, with long shadows sweeping round, and a night.
- **Atmosphere** is off everywhere except the *Hazy ring* sandbox level (quadratic drag relative to the air, which moves with the floor).
- **Levels** are data (`levels.ts`): a ring size and seed fix the layout; enemies are placed by angle and z, or on a ramp's lookout platform; a placement that lands inside cover is nudged clear. `level.shape` is the seam for other kinds of world (only `'ring'` exists): the collision shape, force field and renderer switch on it.
- **Campaign:** fourteen levels.
  - The first, *Basic Training*, teaches the game with timed tips: down is outward, shots curve (the preview shows it), running against the spin makes you lighter. It leaves a revolver about to compare with plasma.
  - The rest are for fun, each with its own gimmick: a tiny fast ring, snipers on lookouts, heavies, hills, *Roadkill* (bases and hover-bikes), the double deck, the log, brawlers in a tube, the power cut, a dense planet, the twin rings, the nested spheres, and Earth to finish.
  - Each level chooses its own pickups (`items`): no jetpack or superweapon where it would make no sense. Enemies drop their guns.
  - Enemy types:
    - Grunt (orange, pistol)
    - Soldier (purple, rifle)
    - Skirmisher (red, overclocked rifle)
    - Heavy (white, fuel rod)
    - Sniper (cyan, cannon)
    - Swarmer (pink, seekers)
    - Gunslinger (yellow, revolver)
    - Brute (black, Grav Mallet)
    - Rocketeer (blue, rockets)
- **Campaign rules:** teams (you vs enemies) with friendly fire off, no respawns, won when every enemy is dead, lost when you die. Enemy types differ in size (their hitbox scales too), colour, health, speed, weapon, range, accuracy and behaviour (chase, strafe, hold).
- **Ring size** scales the map: rim walls are capped at 40% of the radius, ramps and cover shrink on small rings.
- **Obstacle boxes** are axis-aligned in the *local frame* of their ring angle, not in world XYZ. World-aligned boxes would sit crooked on a curved floor.
- **Inputs:** players without a command for a tick repeat their last one, as a server would. Edge-triggered actions (jump, pistol tap, grenade release) use `prevButtons` stored in state, so they replay exactly.
- **Snapshots** use the binary encoder, not JSON, because JSON turns −0 into 0. That can flip an `atan2` branch and break bit-exact replay.
- **Rim walls** vary in height per angular sector (full 15 m, 4 m, or a 1 m curb with orange tops). The SDF evaluates the point's own sector plus any taller neighbours, using the exact distance to the neighbour's edge. Past a curb there is only space: anything more than `fallKillDistance` (default 25 m) off the ring band is dead.
- **Ramps:** one tilted slab each (boxes can tilt about the ring's axis), up to an 11 m lookout where you weigh about 0.88 g. The floor curves up away from a straight slab, so its ends are raised to match exactly: the low end meets the floor and the top meets the platform flush. Alternate ramps climb spinward and antispinward.
- **Rockets** are the one projectile with their own motor, so they can't use the analytic free-flight path: they're integrated with the thrust as an extra force. The nose direction is tracked separately from the velocity. A test checks that the nose stays fixed relative to the stars and that the inertial velocity change is exactly thrust × burn time.
- **Shot speeds** are high enough (80–200 m/s) that bolts barely curve at close range: over distance D a bolt sags about g·D²/2v² and Coriolis bends it up to ω·D²/v, so ~0.5 m over 10 m for the rifle. Across the ring they still curve plenty.
- **Enemy aim:** each enemy type has an `aimSkill` (0–1). 0 aims straight at you; 1 runs the real physics on its own shot (launch rule, spin, your current velocity) and Newton-iterates yaw/pitch on the miss. The aim is blended between the two by skill, plus random wobble (`aimError`).
- **Mesas:** low (3.5 m) platforms with ramps, about one per 80 m of ring, plus denser cover, so big rings aren't empty.
- **Ammo:** `magSize` rounds in the magazine, `ammoMax` spares; reloading takes `reloadTime`. Heat-based weapons have `magSize` 0.
- **Bouncing grenades** (yellow) share one sub-stepped sphere mover with the props and with their own trajectory preview. Their fuse starts at the throw. They bounce off players and props relative to the target's velocity.
- **Terrain:** the floor can carry a height profile: Gaussian hills, and/or a *sphere band*, where the floor is the inside of a sphere of radius R round the equator, so it curves up toward the axis at the edges. The spin still pulls straight away from the axis, so walking toward an edge is like climbing a slope equal to your latitude in weaker g. Collision uses the height function's own gradient (exact for planes, close for smooth hills). Hills keep clear of ramps and lookouts.
- **A whole sphere** (*Inside a Sphere*): a band that goes all the way to the poles, which the rim walls close off. You weigh g cos²(latitude); past about 53° the floor is too steep to stand on (an orange ring marks it) and you slide back toward the equator; near the poles you're almost weightless. The height-field distance estimate breaks down near the poles, so a plain sphere uses its exact distance. A glowing line along the axis and latitude rings make the shape readable, since there's no sky.
- **Silly worlds:**
  - *O'Neill Cylinder*: 2 km across, 3 km long and hilly, with a minute per turn. Three strips of land alternate with three walkable glass windows.
  - *Little O'Neill*: a 500 m-wide pocket version with a biome per land strip (`biomes`): meadow, desert, and snow with the mountains, plus bases.
  - *Swiss Cheese*: holes in the floor. Fall through and the spin flings you out into space.
  - *Double Decker*: a second deck 10 m up, reached by ramps through slots in it and by lifts. A lift is a box whose position is a pure function of time (so replays stay exact), and it carries whoever stands on it.
  - *Stanford Torus*: inside a 40 m tube, so the floor curves up into a ceiling.
  - *Half-Pipe*: half a torus, open toward the axis, with nothing over the lips.
  - *The Log*: you stand on the outside of a spinning tube, on the side facing the axis. Too far round and you slide off.

  How they're built:
  - Holes and decks share one mechanism: a floor or deck is a shell with rectangular prisms cut out of it (`max(d_floor, -d_hole)` in the distance field). The renderer builds the shell on a grid that includes every hole edge, so the cut-outs are exact.
  - Tubes use the exact distance to a circle in the (radius, z) cross-section.
  - Bots won't walk off a drop of more than 2 m, so they avoid holes, ledges and the log's edges (they can still be blasted off).
- **Bases and mountains** (big levels; *Outposts* shows them off):
  - **Bases:** a blue-grey two-storey building. The lower room has chamfered 45° corners, doorways front and back and a diamond pillar. Ramps run up the outside to a roof with low walls and a diamond block for cover, and there are pickups inside and on the roof. Boxes can now turn about the vertical (`yaw`), which is what makes the 45° pieces possible.
  - **Mountains:** as wide as they are tall, so their slopes stay walkable. On the O'Neill cylinder they sit in the land strips, clear of the glass.
  - **Placement:** hills and mountains are kept clear of base sites. Levels with bases skip the lookout ramps.
- **Dense Planet** (`world: 'planet'`): you stand on the outside of a 150 m ball with full gravity toward its centre (falling off as 1/r²), spinning so fast that the equator weighs 60%.
  - **"Up":** everything that needs it (movement, the camera, contacts, bots) gets it from one function, `localBasis`. On a planet it points against the local effective gravity, so at mid latitudes it leans a few degrees toward the equator. East is "spinward".
  - **Geometry:** the ball has an exact distance function. Cover and towers are boxes with explicit axes, so they stand straight out of it.
  - **Orbits:** orbital speed at the surface is 38 m/s and the ground already moves east at 24 m/s. Throw east hard enough and it comes back round behind you. A test sends a bolt once round and checks it returns to within half a metre.
  - **Odd fact:** above the synchronous-orbit radius (about 200 m from the centre) the spin wins, and "down" points away from the planet.
- **Twin Rings** (`twin: true`): two rings side by side on one axis, spinning opposite ways, with a gap at the seam.
  - **Frames:** each body is simulated in the frame of the ring it's over, with that ring's spin (+ω or −ω). When it crosses the seam, its position and velocity are converted exactly into the other ring's frame (`src/sim/twin.ts`). Step over at rest and the other floor carries you off at 2ωR (49 m/s on the 60 m level).
  - **Geometry:** floors and walls look the same from either frame. Boxes belong to one ring, and a query from the other frame rotates into theirs. Nothing straddles the seam.
  - **Rendering:** the client draws everything in the frame of the ring you're on, so the other ring visibly turns past.
  - **Tests:** frame conversion is exact both ways. A bolt fired across the seam flies one straight inertial line through both frames, to 1e-6 m.
  - **Bikes** are simulated in their own ring's frame too, so you can match the other ring's speed and cross. *Counter-Spin Raceway* (150 m rings at 0.4 g, 16 bikes) is built for it: the other floor goes by at 49 m/s, just under a boosted bike's top speed. Ride against the spin flat out, hop the seam, and you land nearly at rest on the other ring. A test does exactly that.
  - **Limits:** blasts and the Mallet don't reach across the seam, and bodies only touch things in their own ring. Each ring's things are at least 2.5 m from the seam, so this rarely shows.
- **Nested Spheres** (`outerShell`): a 60 m ball inside a 120 m shell, with gravity toward the centre plus the spin.
  - **Weights:** the spin is set so the synchronous radius (where gravity and spin cancel) is about 90 m, halfway between. On the ball gravity wins (1 g at the poles, 0.7 g at its equator). On the inside of the shell the spin wins, but only within about 50° of its equator (0.35 g there). Beyond that (an orange ring) you fall off, down to the ball.
  - **Launch pads** on both equators throw you across. Straight up doesn't work: Coriolis turns the climb into an antispinward slide, and arriving at the shell moving against the spin you're too light to stay on it. So the pads throw you about 29° spinward (or antispinward, coming down) at 22 m/s.
  - **Tests** check the three weights, falling off the shell's high latitudes, and both pad crossings.
- **The Ridge:** a Lambda-shaped cross-section: straight 40° flanks rising 120 m from the rim walls to a rounded crest on a 240 m ring, so the crest has half the gravity of the foot. On the flanks the floor carries g cos(slope) of your weight.
- **Changing spin (Euler force):** a level can set `spinChange` and `spinPeriod`. Every cycle the spin winds smoothly down by that fraction (to a dead stop at 1), holds, and winds back up. The spin rate is a pure function of time (taken at mid-tick, so the frame angle is second-order accurate). While it changes, every free body also feels the Euler acceleration −(dω/dt) × r, a push along the floor against the change. It goes into the same kick as the centrifugal force, so contacts, apparent weight, the aim solver and the preview all include it. The exact straight-line projectile path is used only while the spin is steady. A test checks that a free bolt flies a straight inertial line, to within a millimetre, through a spin-down. See *Spin Cycle* (deathmatch) and *Power Cut* (campaign 9).
- **Reversing spin:** `spinChange` above 1 takes the spin through a stop and on backwards (2 = full speed backwards). See *Reversal*. The same tests apply: free flight stays a straight inertial line right through the reversal.
- **Tidal Spheres:** nested spheres (a 60 m ball in a 75 m shell) whose spin comes and goes, with no launch pads. Spun up (peak spin twice the ball's gravity), only the ball's poles hold you, and everyone else is flung to the shell. Spun down, the shell lets go and everyone falls back to the ball. The shell is close enough that both trips land under the impact-damage speed; tests check both.
- **Disk World** (`world: 'disk'`): you stand on top of a spinning disk with a uniform pull straight down (g), like *Skyhook*'s planet but fixed under the disk. In the disk's frame the spin adds an outward push ω²ρ, so "down" tilts toward the edge the further out you go. `planetSpin` sets that push at the rim as a multiple of g (1.6 on the 100 m level), so past ρ = (4/3)·R/1.6 ≈ 83 m (where the push reaches 4/3 g) the floor is steeper than you can stand on, and you slide off the edge into space.
- **Spinning Bucket** (`diskBowl: true`): the same disk curved up into the paraboloid z = ω²ρ²/2g, the shape water takes in a spinning bucket, so the floor is everywhere square to gravity plus spin and you can stand anywhere. At the 80 m-high rim you weigh √(1 + 1.6²) ≈ 1.9 g. Both disks are in the custom builder too.
- **Skyhook (planet below):** `planetPull` adds a uniform pull toward a planet that is fixed to the stars, so in the ring's frame it sweeps round once per spin. At 0.9 g you go from 1.9 g to almost weightless each turn, and shots curve with it; enemy aim and the trajectory preview use the same field. The ring isn't in orbit: it turns on an axle held up by a tower standing on the planet.
- **Hover-bikes** (big rings, where there are plenty, one beside every spawn point; or spawn one from the debug panel's *Give*): a physics sphere with its own health.
  - **Hover:** it floats on a damped spring at a ride height over whatever floor-like surface is under it (floor, ramp, hillside), so it glides over bumps and ramp lips and soaks up landings, rather than rolling on its sphere.
  - **Handling:** it faces where you look. Sliding sideways dies away fast (grip) while rolling forward barely slows, so it carves round corners; momentum, the spin and slopes still matter. W/S thrust, A/D strafe, Space hops, Shift boosts. It leans into turns and tilts with the ground.
  - **Damage:** only very fast crashes into walls or boxes (over 40 m/s) hurt the bike; landings never do; the rider is never hurt by crashes. A ridden bike moving at you runs you over from just 3 m/s: it hurts, and throws you along the bike's path and up into the air (credited to the rider), and the bike barely slows. A parked bike is just a heavy object: walk into it and you bump it.
  - Shots, blasts, the mallet and sticky grenades work on it. At zero health it explodes, throws the rider clear and respawns at its spot later.
  - Parked bikes sleep until something disturbs them, so even the huge levels' dozens of bikes cost almost nothing.
  - All of it is tunable in the debug panel.
- **Enemy movement:** besides chase / strafe / hold, enemies with shields break for cover when shields drop below half: they pick the nearest box and stand on its far side from you, holding fire until the shields recover. If you're up on a lookout or mesa they go round to the foot of the nearest ramp and climb it. Up off the floor they won't strafe off an edge.
- **Owner self-hits:** a projectile is `armed` against its owner once it has left the owner's capsule. The test fires a bolt antispinward at the local rim speed, and it hits the shooter in the back ≈ 2π/ω later.

## Known limitations / next steps

- No networking yet. The pieces are in place: inputs are per tick, the state is serializable, and restore-and-replay is exact.
- Player-vs-player and prop collisions are simple positional pushes. There is no rigid-body rotation, and prop rolling is visual only.
- Explosions ignore line of sight.
- Enemy navigation is local (cover and ramps, no path-finding): an enemy that loses sight of you just waits.
- Pickups are floating items, not physics objects. Dropped items hang where they land, 0.7 m above the floor.
