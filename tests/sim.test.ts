import { describe, expect, it } from 'vitest';
import {
  BTN_FIRE, BTN_JUMP, BTN_SPRINT, DT, PLAYER_HALF_SEG, PLAYER_RADIUS, GRENADE_RADIUS,
  addPlayer, addProp, botInput, createState, decode, detonate, encode, falloff, hash01, integrate,
  jacobi, knockDir, localBasis, omegaOf, propagateAnalytic, restore, snapshot, spawnBolt, spawnGrenade,
  step, viewVectors, muzzlePoint, levelSdf, sectorOf, distanceOffRing, BTN_GRENADE2,
  isLaconicBusy, predictTrajectory, solveAim, damageVehicle, dist, BTN_USE, launchVelocity, advanceFree, WEAPON_HAMMER, WEAPON_HOVER, WEAPON_CANNON, WEAPON_LACONIC, WEAPON_LAUNCHER, BTN_MELEE, BTN_RELOAD, aimAt, WEAPON_RED, applyItem, damagePlayer, addScaled, dot,
  LEVELS, levelById, startLevel, add, scale, addVehicle, WEAPON_ROCKET, terrainAt, type InputCmd, type SimState, type Vec3,
} from '../src/sim';

const empty = (config = {}, variedWalls = false) => createState({ obstacles: false, props: false, dummies: false, variedWalls, config });
const run = (s: SimState, n: number, inputs: (s: SimState) => InputCmd[] = () => []) => {
  for (let i = 0; i < n; i++) step(s, inputs(s), s.tick);
};
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const cmdFor = (s: SimState, id: number, o: Partial<InputCmd> = {}): InputCmd => ({
  playerId: id, tick: s.tick, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0, ...o,
});
const angleOf = (p: Vec3) => Math.atan2(p[1], p[0]);

describe('1. rest', () => {
  it('a prop at rest on the floor stays at rest', () => {
    const s = empty();
    const r = 0.5;
    addProp(s, [s.config.R - r, 0, 3], r);
    run(s, 2); // first contact establishes the support normal
    const start = [...s.props[0].pos];
    run(s, 120 * 20);
    const p = s.props[0];
    expect(Math.hypot(p.pos[0] - start[0], p.pos[1] - start[1], p.pos[2] - start[2])).toBeLessThan(1e-9);
    expect(Math.hypot(...p.vel)).toBeLessThan(1e-9);
  });
  it('a standing player stays put', () => {
    const s = empty();
    addPlayer(s, 'human', 'P');
    run(s, 30);
    const start = [...s.players[0].pos];
    run(s, 120 * 20);
    const p = s.players[0];
    expect(p.grounded).toBe(true);
    expect(Math.hypot(p.pos[0] - start[0], p.pos[1] - start[1], p.pos[2] - start[2])).toBeLessThan(1e-6);
    expect(p.apparentG).toBeCloseTo((omegaOf(s.config) ** 2 * (s.config.R - PLAYER_HALF_SEG)) / s.config.g, 2);
  });
});

/** Fly a test grenade (sticks on first contact) until it lands; returns landing angle. */
function landGrenade(s: SimState, pos: Vec3, vel: Vec3) {
  const g = spawnGrenade(s, -1, pos, vel);
  for (let i = 0; i < 120 * 30 && !g.stuck; i++) step(s, [], s.tick);
  expect(g.stuck).not.toBeNull();
  return { angle: angleOf(g.pos), pos: g.pos };
}

describe('2. drop test', () => {
  it.each([1, 5, 20])('released from h=%d m lands antispinward on the exact chord', (h) => {
    const s = empty();
    const w = omegaOf(s.config);
    const Re = s.config.R - GRENADE_RADIUS; // sphere centre touches at R - radius
    const r0 = Re - h;
    const res = landGrenade(s, [r0, 0, 0], [0, 0, 0]);
    // Inertial: straight line from (r0,0) with tangential speed w*r0.
    const t = Math.sqrt(Re * Re - r0 * r0) / (w * r0);
    const phi = Math.acos(r0 / Re);
    const expected = phi - w * t; // negative = antispinward
    expect(expected).toBeLessThan(0);
    expect(res.angle).toBeLessThan(0);
    expect(Math.abs(res.angle - expected) * Re).toBeLessThan(2e-3); // < 2 mm along the floor
  });
});

describe('3. throw-up test', () => {
  const exactSpinward = (Re: number, w: number, u: number) => {
    const t = (2 * Re * u) / (u * u + w * w * Re * Re);
    return Math.atan2(w * Re * t, Re - u * t) - w * t;
  };
  it('small u lands spinward by ~ (4/3) w u^3 / g^2', () => {
    const s = empty();
    const w = omegaOf(s.config);
    const Re = s.config.R - GRENADE_RADIUS;
    const u = 1;
    const res = landGrenade(s, [Re, 0, 0], [-u, 0, 0]);
    const geff = w * w * Re;
    const approx = (4 / 3) * w * u ** 3 / geff ** 2;
    const exact = exactSpinward(Re, w, u) * Re;
    expect(res.angle).toBeGreaterThan(0);
    expect(Math.abs(exact - approx) / approx).toBeLessThan(0.03);
    expect(Math.abs(res.angle * Re - exact)).toBeLessThan(1e-4);
  });
  it('u = 20 m/s on R = 100 matches the exact chord (~23 m spinward)', () => {
    const s = empty();
    const w = omegaOf(s.config);
    const Re = s.config.R - GRENADE_RADIUS;
    const res = landGrenade(s, [Re, 0, 0], [-20, 0, 0]);
    const exact = exactSpinward(Re, w, 20) * Re;
    expect(exact).toBeGreaterThan(22);
    expect(exact).toBeLessThan(24);
    expect(Math.abs(res.angle * Re - exact)).toBeLessThan(5e-3);
  });
});

describe('4. hover test', () => {
  for (const mode of ['prop (integrator)', 'hover bolt (analytic)'] as const) {
    it(`${mode}: v = -w x r keeps constant radius and returns after 2pi/w`, () => {
      const s = empty();
      const w = omegaOf(s.config);
      const r0: Vec3 = [50, 0, 2];
      const v0: Vec3 = [w * r0[1], -w * r0[0], 0];
      let get: () => Vec3;
      if (mode === 'prop (integrator)') {
        addProp(s, r0, 0.3, v0);
        get = () => s.props[0].pos;
      } else {
        const b = spawnBolt(s, -1, 'hover', r0, v0);
        get = () => b.pos;
      }
      const n = Math.round((2 * Math.PI) / w / DT) + (mode === 'prop (integrator)' ? 0 : 1);
      let maxDr = 0;
      for (let i = 0; i < n; i++) {
        step(s, [], s.tick);
        const p = get();
        maxDr = Math.max(maxDr, Math.abs(Math.hypot(p[0], p[1]) - 50));
        // angle in the rotating frame goes as -w t exactly
        // (a bolt does not move on its spawn tick: its end-of-tick state is the launch state)
        const expectAng = -w * (mode === 'prop (integrator)' ? i + 1 : i) * DT;
        const d = Math.atan2(Math.sin(angleOf(p) - expectAng), Math.cos(angleOf(p) - expectAng));
        expect(Math.abs(d)).toBeLessThan(mode === 'prop (integrator)' ? 5e-4 : 1e-6); // 2nd-order phase error vs exact
      }
      expect(maxDr).toBeLessThan(mode === 'prop (integrator)' ? 5e-4 : 1e-6); // integrator: O((w dt)^2) relative
      const p = get();
      expect(Math.hypot(p[0] - r0[0], p[1] - r0[1], p[2] - r0[2])).toBeLessThan(w * 50 * DT);
    });
  }
});

describe('5. Jacobi integral', () => {
  it('is conserved by the integrator over 1000+ s with drag = 0', () => {
    const cfg = empty().config;
    const w = omegaOf(cfg);
    const r: Vec3 = [50, 0, 0];
    const v: Vec3 = [w * 0 + 0.03, -w * 50 + 0.02, 0.01]; // nearly hovering: stays in a bounded region
    const J0 = jacobi(r, v, w);
    let maxErr = 0;
    const N = Math.round(1200 / DT);
    for (let i = 0; i < N; i++) {
      integrate(r, v, DT, w, cfg);
      if (i % 50 === 0) maxErr = Math.max(maxErr, Math.abs(jacobi(r, v, w) - J0));
    }
    const scale = 0.5 * w * w * (r[0] * r[0] + r[1] * r[1]);
    expect(maxErr / scale).toBeLessThan(1e-5);
  });
  it('is conserved for a fast flight across the ring (relative to |v|^2)', () => {
    const cfg = empty().config;
    const w = omegaOf(cfg);
    const r: Vec3 = [98, 0, 0];
    const v: Vec3 = [-25, 10, 3]; // crosses the 200 m ring in ~6 s
    const J0 = jacobi(r, v, w);
    let maxErr = 0;
    for (let i = 0; i < Math.round(6 / DT); i++) {
      integrate(r, v, DT, w, cfg);
      maxErr = Math.max(maxErr, Math.abs(jacobi(r, v, w) - J0) / (0.5 * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2)));
    }
    expect(maxErr).toBeLessThan(1e-5);
  });
  it('is conserved inside the full sim for an elastic bouncer (drag = 0, frictionless)', () => {
    const s = empty({ restitution: 1, friction: 0 });
    const w = omegaOf(s.config);
    addProp(s, [90, 0, 0], 0.3, [3, 5, 6]); // chords stay below the wall tops: bounces off floor and rim walls
    const pr = s.props[0];
    const J0 = jacobi(pr.pos, pr.vel, w);
    let bounces = 0, maxErr = 0;
    for (let i = 0; i < 120 * 60; i++) {
      step(s, [], s.tick);
      bounces += s.events.filter((e) => e.type === 'bodyImpact').length;
      maxErr = Math.max(maxErr, Math.abs(jacobi(pr.pos, pr.vel, w) - J0) / Math.abs(J0));
    }
    expect(bounces).toBeGreaterThan(5);
    expect(maxErr).toBeLessThan(1e-3);
  });
});

describe('6. analytic vs integrator', () => {
  it('agree within tolerance over a long flight', () => {
    const cfg = empty().config;
    const w = omegaOf(cfg);
    const ra: Vec3 = [98.5, 0, 0], va: Vec3 = [-3, 12, 4];
    const ri: Vec3 = [...ra], vi: Vec3 = [...va];
    let maxErr = 0;
    for (let i = 0; i < 6 / DT; i++) {
      propagateAnalytic(ra, va, w, DT);
      integrate(ri, vi, DT, w, cfg);
      maxErr = Math.max(maxErr, Math.hypot(ra[0] - ri[0], ra[1] - ri[1], ra[2] - ri[2]));
    }
    expect(maxErr).toBeLessThan(2e-3);
    // one-shot analytic from launch == per-tick composition
    const r1: Vec3 = [98.5, 0, 0], v1: Vec3 = [-3, 12, 4];
    propagateAnalytic(r1, v1, w, 720 * DT);
    expect(Math.hypot(r1[0] - ra[0], r1[1] - ra[1], r1[2] - ra[2])).toBeLessThan(1e-9);
  });
});

describe('7. relative launch', () => {
  it('a bolt from a running player launches at v_player + muzzle * aim', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const cmd = (buttons: number): InputCmd => ({ playerId: id, tick: s.tick, moveX: 0, moveY: 1, yaw: 0.3, pitch: 0.1, buttons, weapon: 0 });
    run(s, 180, () => [cmd(BTN_SPRINT)]);
    expect(Math.hypot(...p.vel)).toBeGreaterThan(7);
    step(s, [cmd(BTN_SPRINT | BTN_FIRE)], s.tick);
    expect(s.bolts.length).toBe(1);
    const b = s.bolts[0];
    const aim = viewVectors(p.pos, p.yaw, p.pitch).aim;
    for (let i = 0; i < 3; i++) expect(b.launchVel[i]).toBeCloseTo(p.vel[i] + s.config.weapons.rifle.muzzle * aim[i], 12);
    expect(Math.hypot(...b.vel)).toBeGreaterThan(s.config.weapons.rifle.muzzle + 5);
  });
  it('the same rule applies to thrown grenades', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const cmd = (buttons: number): InputCmd => ({ playerId: id, tick: s.tick, moveX: 1, moveY: 0, yaw: 0, pitch: 0.2, buttons, weapon: 0 });
    run(s, 120, () => [cmd(16)]);
    step(s, [cmd(0)], s.tick);
    const g = s.grenades[0];
    const aim = viewVectors(p.pos, p.yaw, p.pitch).aim;
    for (let i = 0; i < 3; i++) expect(g.launchVel[i]).toBeCloseTo(p.vel[i] + s.config.muzzleGrenade * aim[i], 12);
  });
  it("a bolt fired antispinward at rim speed hits its owner in the back one period later", () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 30);
    const p = s.players[0];
    const w = omegaOf(s.config);
    // Aim exactly antispinward *at the muzzle* with speed = local rim speed, so the
    // bolt is at rest in the inertial frame (fixed point iteration on the muzzle offset).
    let yaw = Math.PI, pitch = 0;
    for (let k = 0; k < 4; k++) {
      const m = muzzlePoint(p, yaw, pitch);
      const want: Vec3 = [w * m[1], -w * m[0], 0]; // -w x r
      s.config.weapons.rifle.muzzle = Math.hypot(...want);
      const b = localBasis(p.pos);
      const ft = want[0] * b.spin[0] + want[1] * b.spin[1], fu = want[0] * b.up[0] + want[1] * b.up[1];
      yaw = Math.atan2(0, ft);
      pitch = Math.atan2(fu, Math.abs(ft));
    }
    const cmd = (bt: number): InputCmd => ({ playerId: id, tick: s.tick, moveX: 0, moveY: 0, yaw, pitch, buttons: bt, weapon: 0 });
    step(s, [cmd(BTN_FIRE)], s.tick);
    const fireTick = s.tick;
    let hitTick = -1;
    for (let i = 0; i < 120 * 25 && hitTick < 0; i++) {
      step(s, [cmd(0)], s.tick);
      if (s.events.some((e) => e.type === 'hit' && e.target === id && e.attacker === id)) hitTick = s.tick;
    }
    const T = (2 * Math.PI) / w;
    expect(hitTick).toBeGreaterThan(0);
    expect(Math.abs((hitTick - fireTick) * DT - T)).toBeLessThan(0.3);
  });
});

describe('8. knockback', () => {
  it('impulse direction and falloff are correct', () => {
    const s = empty();
    addPlayer(s, 'human', 'P');
    run(s, 10);
    const p = s.players[0];
    const up = localBasis(p.pos).up;
    const spin = localBasis(p.pos).spin;
    for (const d of [0.5, 2, 4, 5.9, 7]) {
      p.vel = [0, 0, 0];
      p.health = 1e9;
      // blast d metres from the capsule surface, off to the antispinward side at mid height
      const c: Vec3 = [p.pos[0] - spin[0] * (PLAYER_RADIUS + d), p.pos[1] - spin[1] * (PLAYER_RADIUS + d), p.pos[2]];
      detonate(s, c, -1, -1);
      const dv = Math.hypot(...p.vel);
      const exp = s.config.knockbackSpeed * s.config.knockbackScale * falloff(s.config, d / s.config.explosionRadius);
      expect(dv).toBeCloseTo(exp, 9);
      if (exp > 0) {
        const dir = knockDir([p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]], up, s.config.liftBias);
        for (let i = 0; i < 3; i++) expect(p.vel[i] / dv).toBeCloseTo(dir[i], 9);
        // pushed spinward (away from blast) and toward the axis (lift bias)
        expect(p.vel[0] * spin[0] + p.vel[1] * spin[1]).toBeGreaterThan(0);
        expect(p.vel[0] * up[0] + p.vel[1] * up[1]).toBeGreaterThan(0);
      }
    }
  });
  it('a sticky grenade at your feet launches you at ~ the configured speed', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = s.players[0];
    const feet: Vec3 = [p.pos[0] * (1 + 0.6 / Math.hypot(p.pos[0], p.pos[1])), p.pos[1] * (1 + 0.6 / Math.hypot(p.pos[0], p.pos[1])), p.pos[2] + 0.1];
    const g = spawnGrenade(s, id, feet, [0, 0, 0]);
    g.stuck = { kind: 'world' };
    g.fuseTick = s.tick + 1;
    let launched = 0;
    for (let i = 0; i < 4; i++) {
      step(s, [], s.tick);
      launched = Math.max(launched, Math.hypot(...p.vel));
    }
    expect(launched).toBeGreaterThan(s.config.knockbackSpeed * 0.9);
    expect(launched).toBeLessThan(s.config.knockbackSpeed * 1.1);
    expect(p.alive).toBe(true); // self damage is scaled down
    // and it is a long flight: still airborne a second later
    run(s, 120);
    expect(p.grounded).toBe(false);
  });
});

// ------------------------------------------------------------ determinism

function scriptedHuman(id: number) {
  return (s: SimState): InputCmd => {
    const t = s.tick;
    return {
      playerId: id, tick: t,
      moveX: hash01(id, t >> 6, 1) * 2 - 1,
      moveY: hash01(id, t >> 6, 2) * 2 - 1,
      yaw: Math.sin(t * 0.003) * 3,
      pitch: Math.sin(t * 0.0021) * 0.6,
      buttons: (hash01(id, t >> 4, 3) < 0.4 ? BTN_FIRE : 0) | (hash01(id, t >> 5, 4) < 0.05 ? BTN_JUMP : 0) | (hash01(id, t >> 5, 5) < 0.08 ? 16 : 0),
      weapon: Math.floor(hash01(id, t >> 9, 6) * 3),
    };
  };
}

function fullWorld() {
  const s = createState({ seed: 99 });
  const human = addPlayer(s, 'human', 'You');
  const bots = [addPlayer(s, 'bot', 'B1'), addPlayer(s, 'bot', 'B2'), addPlayer(s, 'bot', 'B3')];
  const h = scriptedHuman(human);
  const inputs = (st: SimState) => [h(st), ...bots.map((b) => botInput(st, b))];
  return { s, inputs };
}

describe('9. determinism', () => {
  it('same initial state + same inputs => identical state after 10,000 ticks', { timeout: 60000 }, () => {
    const a = fullWorld(), b = fullWorld();
    let fired = 0, explosions = 0;
    for (let i = 0; i < 10000; i++) {
      step(a.s, a.inputs(a.s), a.s.tick);
      fired += a.s.events.filter((e) => e.type === 'fire').length;
      explosions += a.s.events.filter((e) => e.type === 'explode').length;
      step(b.s, b.inputs(b.s), b.s.tick);
    }
    expect(fired).toBeGreaterThan(100); // the run actually did things
    expect(explosions).toBeGreaterThan(0);
    expect(bytesEqual(encode(a.s), encode(b.s))).toBe(true);
  });
});

describe('10. snapshot round-trip', () => {
  it('restore + replay reproduces the original run exactly', { timeout: 60000 }, () => {
    const { s, inputs } = fullWorld();
    run(s, 3000, inputs);
    const snap = snapshot(s);
    const log: InputCmd[][] = [];
    for (let i = 0; i < 3000; i++) {
      const inp = inputs(s);
      log.push(inp);
      step(s, inp, s.tick);
    }
    const r = restore(snap);
    for (const inp of log) step(r, inp, r.tick);
    expect(bytesEqual(encode(r), encode(s))).toBe(true);
  });
  it('encode/decode is lossless (including -0) and compact', () => {
    const { s, inputs } = fullWorld();
    run(s, 600, inputs);
    s.players[0].vel[2] = -0;
    const bytes = encode(s);
    const back = decode(bytes);
    expect(back).toEqual(s);
    expect(Object.is(back.players[0].vel[2], -0)).toBe(true);
    expect(bytes.byteLength).toBeLessThan(JSON.stringify(s).length);
  });
});

// ------------------------------------------------------------ playtest round 1 features

describe('11. bouncing grenades', () => {
  it('bounce instead of sticking and go off when the fuse (started at the throw) runs out', () => {
    const s = empty();
    const Re = s.config.R - GRENADE_RADIUS;
    const g = spawnGrenade(s, -1, [Re - 3, 0, 0], [8, 6, 1], 'bounce');
    const fuseTicks = Math.round(s.config.bounceFuse / DT);
    let bounces = 0, explodedAt = -1;
    while (explodedAt < 0 && s.tick < 2000) {
      step(s, [], s.tick);
      bounces += s.events.filter((e) => e.type === 'grenadeBounce').length;
      if (s.events.some((e) => e.type === 'explode' && e.id === g.id)) explodedAt = s.tick - 1;
      if (explodedAt < 0) expect(g.stuck).toBeNull();
    }
    expect(bounces).toBeGreaterThanOrEqual(2);
    expect(explodedAt - g.spawnTick).toBe(fuseTicks);
  });
  it('are thrown with the relative-launch rule via their own button', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const cmd = (b: number): InputCmd => ({ playerId: id, tick: s.tick, moveX: 0, moveY: 1, yaw: 0.4, pitch: 0.3, buttons: b, weapon: 0 });
    run(s, 120, () => [cmd(BTN_GRENADE2)]);
    step(s, [cmd(0)], s.tick);
    expect(s.grenades.length).toBe(1);
    const g = s.grenades[0];
    expect(g.variant).toBe('bounce');
    expect(p.bounceGrenades).toBe(3);
    expect(p.grenades).toBe(4);
    const aim = viewVectors(p.pos, p.yaw, p.pitch).aim;
    for (let i = 0; i < 3; i++) expect(g.launchVel[i]).toBeCloseTo(p.vel[i] + s.config.muzzleGrenade * aim[i], 12);
  });
});

describe('12. low walls and falling off the ring', () => {
  it('rim walls vary in height; low sectors are open above the curb', () => {
    const s = createState({ seed: 5 });
    const { wallPos } = s.level;
    const R = s.config.R, W = s.config.halfWidth, T = s.config.wallThickness;
    const n = wallPos.length;
    const low = wallPos.findIndex((h) => h <= 1);
    const tall = wallPos.findIndex((h) => h >= s.config.wallHeight);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(tall).toBeGreaterThanOrEqual(0);
    const at = (i: number, height: number): Vec3 => {
      const a = ((i + 0.5) / n) * 2 * Math.PI;
      return [(R - height) * Math.cos(a), (R - height) * Math.sin(a), W + T / 2];
    };
    expect(sectorOf(((low + 0.5) / n) * 2 * Math.PI, n)).toBe(low);
    expect(levelSdf(s.level, s.config, at(low, 3)).d).toBeGreaterThan(1.5); // 3 m up, above a 1 m curb
    expect(levelSdf(s.level, s.config, at(tall, 3)).d).toBeLessThan(0); // inside a full wall
  });
  it('a player who walks off the edge falls away and dies past fallKillDistance', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const W = s.config.halfWidth + s.config.wallThickness;
    // just past the end of the hull, at rest relative to the (absent) floor
    p.pos = [s.config.R - 1, 0, W + 0.5];
    p.vel = [0, 0, 0.5];
    p.grounded = false;
    p.groundNormal = null;
    let deathTick = -1;
    for (let i = 0; i < 120 * 10 && deathTick < 0; i++) {
      step(s, [], s.tick);
      const k = s.events.find((e) => e.type === 'kill' && e.victim === id);
      if (k) {
        deathTick = s.tick;
        expect(k.type === 'kill' && k.cause).toBe('spaced');
      } else expect(distanceOffRing(s.config, p.pos)).toBeLessThanOrEqual(s.config.fallKillDistance + 0.5);
    }
    expect(deathTick).toBeGreaterThan(120); // a real fall, not an instant kill
    expect(p.alive).toBe(false);
  });
  it('a grenade-jump over a low curb carries you off the ring', () => {
    const s = createState({ seed: 5, obstacles: false, props: false, dummies: false });
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const n = s.level.wallPos.length;
    const low = s.level.wallPos.findIndex((h) => h <= 1);
    const a = ((low + 0.5) / n) * 2 * Math.PI;
    const R = s.config.R;
    p.pos = [(R - 0.9) * Math.cos(a), (R - 0.9) * Math.sin(a), s.config.halfWidth - 3];
    run(s, 10);
    const b = localBasis(p.pos);
    p.vel = [b.up[0] * 10, b.up[1] * 10, 10]; // like a blast from the inboard side
    let spaced = false;
    for (let i = 0; i < 120 * 12 && !spaced; i++) {
      step(s, [], s.tick);
      spaced = s.events.some((e) => e.type === 'kill' && e.victim === id && e.cause === 'spaced');
    }
    expect(spaced).toBe(true);
  });
});

describe('13. tunable movement', () => {
  it('walk speed and jump speed come from the config', () => {
    const s = empty({ walkSpeed: 20, jumpSpeed: 12 });
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const cmd = (b: number, y = 1): InputCmd => ({ playerId: id, tick: s.tick, moveX: 0, moveY: y, yaw: Math.PI / 2, pitch: 0, buttons: b, weapon: 0 });
    run(s, 120, () => [cmd(0)]);
    expect(Math.hypot(...p.vel)).toBeCloseTo(20, 1);
    run(s, 120, () => [cmd(0, 0)]);
    const r0 = Math.hypot(p.pos[0], p.pos[1]);
    step(s, [cmd(BTN_JUMP, 0)], s.tick);
    let apex = 0;
    for (let i = 0; i < 600 && !(i > 10 && p.grounded); i++) {
      step(s, [cmd(0, 0)], s.tick);
      apex = Math.max(apex, r0 - Math.hypot(p.pos[0], p.pos[1]));
    }
    // Exact: a straight inertial line from radius r0 with radial speed u and tangential w*r0
    // gets no closer to the axis than its impact parameter.
    const w = omegaOf(s.config), u = 12;
    const expected = r0 - (r0 * w * r0) / Math.hypot(u, w * r0);
    expect(Math.abs(apex - expected)).toBeLessThan(0.1);
    expect(apex).toBeLessThan((u * u) / (2 * s.config.g)); // lower than flat-ground u^2/2g
  });
});

describe('14. ramps', () => {
  it('a ramp can be walked (no jumping) up to its 11 m lookout', () => {
    const s = createState({ seed: 3, props: false, pickups: false });
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const R = s.config.R;
    const pieces = s.level.boxes.filter((b) => b.kind === 'ramp' && b.tilt !== 0);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    // the first ramp climbs spinward: start 2 m before its lowest piece
    const first = pieces[0];
    expect(first.tilt).toBeGreaterThan(0);
    const a = first.angle - (first.half[0] + 2) / R;
    p.pos = [(R - 0.9) * Math.cos(a), (R - 0.9) * Math.sin(a), first.center[2]];
    run(s, 10);
    const height = () => R - Math.hypot(p.pos[0], p.pos[1]) - 0.9;
    let maxH = 0, airborne = 0;
    for (let i = 0; i < 120 * 6; i++) {
      step(s, [cmdFor(s, id, { moveY: 1, yaw: 0 })], s.tick);
      maxH = Math.max(maxH, height());
      if (!p.grounded) airborne++;
      if (height() > 10.9) break;
    }
    expect(maxH).toBeGreaterThan(10.9);
    expect(airborne).toBeLessThan(20); // walked, didn't bounce up
  });
});

describe('15. running and jumping (regression)', () => {
  for (const [label, yaw, sign] of [['antispinward', Math.PI, -1], ['spinward', 0, 1]] as const) {
    it(`sprinting ${label} stays on the floor, can always jump, and weighs (wR ${sign > 0 ? '+' : '-'} v)^2/R`, () => {
      const v = 9;
      const s = empty({ sprintSpeed: v });
      const id = addPlayer(s, 'human', 'P');
      const p = s.players[0];
      run(s, 240, () => [cmdFor(s, id, { moveY: 1, yaw, buttons: BTN_SPRINT })]);
      let flips = 0, prev = p.grounded;
      for (let i = 0; i < 240; i++) {
        step(s, [cmdFor(s, id, { moveY: 1, yaw, buttons: BTN_SPRINT })], s.tick);
        if (p.grounded !== prev) flips++;
        prev = p.grounded;
      }
      expect(flips).toBe(0);
      const w = omegaOf(s.config), R = s.config.R;
      const expected = (w * R + sign * v) ** 2 / R / s.config.g;
      expect(Math.abs(p.apparentG - expected) / expected).toBeLessThan(0.05);
      step(s, [cmdFor(s, id, { moveY: 1, yaw, buttons: BTN_SPRINT | BTN_JUMP })], s.tick);
      expect(s.events.some((e) => e.type === 'jump')).toBe(true);
    });
  }
  it('coyote time: a jump still works just after leaving a surface, not long after', () => {
    for (const [ago, ok] of [[5, true], [40, false]] as const) {
      const s = empty();
      const id = addPlayer(s, 'human', 'P');
      const p = s.players[0];
      run(s, 20);
      p.pos = addScaled(p.pos, localBasis(p.pos).up, 0.5); // just above the floor
      p.grounded = false;
      p.groundNormal = null;
      p.lastGroundTick = s.tick - ago;
      step(s, [cmdFor(s, id, { buttons: BTN_JUMP })], s.tick);
      expect(s.events.some((e) => e.type === 'jump')).toBe(ok);
    }
  });
  it('air control steers you, but only up to walk speed', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    run(s, 20);
    p.vel = addScaled([0, 0, 0], localBasis(p.pos).up, 12); // straight up, long hang time
    p.grounded = false;
    p.groundNormal = null;
    const before = dot(p.vel, [0, 0, 1]);
    run(s, 120, () => [cmdFor(s, id, { moveY: 1, yaw: Math.PI / 2 })]); // push toward +Z
    const vz = p.vel[2] - before;
    expect(p.grounded).toBe(false);
    expect(vz).toBeGreaterThan(4);
    expect(vz).toBeLessThanOrEqual(s.config.walkSpeed + 1e-9);
  });
});

describe('16. impact damage', () => {
  it('hitting the floor hard hurts; landing a normal jump does not', () => {
    for (const [speed, hurts] of [[35, true], [12, false]] as const) {
      const s = empty();
      const id = addPlayer(s, 'human', 'P');
      const p = s.players[0];
      run(s, 20);
      const h0 = p.health + p.shield;
      p.pos = addScaled(p.pos, localBasis(p.pos).up, 1);
      p.vel = addScaled([0, 0, 0], localBasis(p.pos).up, -speed);
      p.grounded = false;
      p.groundNormal = null;
      run(s, 30);
      expect(p.health + p.shield < h0).toBe(hurts);
      void id;
    }
  });
});

describe('17. weapons', () => {
  const give = (s: SimState, item: string) => {
    const p = s.players[0];
    expect(applyItem(s.config, p, item as never, -1)).toBe(true);
    return p;
  };
  it('fuel rod launcher: 3-round magazine, 9 spares, reloads, explodes on impact', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = give(s, 'launcher');
    expect([p.mag[WEAPON_LAUNCHER], p.ammo[WEAPON_LAUNCHER]]).toEqual([3, 9]);
    let shots = 0, booms = 0, reloads = 0, firstReloadAt = -1;
    for (let i = 0; i < 120 * 30; i++) {
      const fire = i % 20 === 10 ? BTN_FIRE : 0; // mash the trigger
      step(s, [cmdFor(s, id, { weapon: WEAPON_LAUNCHER, pitch: -0.6, buttons: fire })], s.tick);
      shots += s.events.filter((e) => e.type === 'fire' && e.kind === 'fuelRod').length;
      booms += s.events.filter((e) => e.type === 'explode').length;
      if (s.events.some((e) => e.type === 'reload')) { reloads++; if (firstReloadAt < 0) firstReloadAt = shots; }
    }
    expect(firstReloadAt).toBe(3); // a magazine is 3 shots
    expect(reloads).toBe(3);
    expect(shots).toBe(12);
    expect(booms).toBe(12);
    expect([p.mag[WEAPON_LAUNCHER], p.ammo[WEAPON_LAUNCHER]]).toEqual([0, 0]);
    expect(applyItem(s.config, p, 'launcher', -1)).toBe(true); // refill
    expect(p.mag[WEAPON_LAUNCHER] + p.ammo[WEAPON_LAUNCHER]).toBe(12);
    expect(applyItem(s.config, p, 'launcher', -1)).toBe(false); // already full: leave it
  });
  it('R reloads a part-empty magazine; spares top it up', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = give(s, 'launcher');
    run(s, 60, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER })]);
    step(s, [cmdFor(s, id, { weapon: WEAPON_LAUNCHER, pitch: -0.6, buttons: BTN_FIRE })], s.tick);
    expect(p.mag[WEAPON_LAUNCHER]).toBe(2);
    step(s, [cmdFor(s, id, { weapon: WEAPON_LAUNCHER, buttons: BTN_RELOAD })], s.tick);
    expect(s.events.some((e) => e.type === 'reload')).toBe(true);
    run(s, Math.round(s.config.weapons.launcher.reloadTime / DT) + 2, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER })]);
    expect([p.mag[WEAPON_LAUNCHER], p.ammo[WEAPON_LAUNCHER]]).toEqual([3, 8]);
  });
  it('campaign enemies never run dry but still reload', () => {
    const { state, botIds } = startLevel(levelById('c4')!);
    const heavy = state.players.find((p) => p.enemyType === 'heavy')!;
    expect(heavy.infiniteAmmo).toBe(true);
    let reloads = 0, shots = 0;
    for (let i = 0; i < 120 * 40; i++) {
      // fire the heavy's launcher as fast as it allows
      const cmds = botIds.map((b) => (b === heavy.id ? cmdFor(state, b, { weapon: WEAPON_LAUNCHER, pitch: -0.5, buttons: i % 2 ? BTN_FIRE : 0 }) : cmdFor(state, b)));
      step(state, cmds, state.tick);
      reloads += state.events.filter((e) => e.type === 'reload' && e.id === heavy.id).length;
      shots += state.events.filter((e) => e.type === 'fire' && e.owner === heavy.id).length;
    }
    expect(shots).toBeGreaterThan(20); // far more than 3 + 9
    expect(reloads).toBeGreaterThanOrEqual(Math.floor(shots / 3) - 1);
  });
  it('plasma bolt cannon: one fast, hard shot, then a short overheat', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = give(s, 'cannon');
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_CANNON })]);
    step(s, [cmdFor(s, id, { weapon: WEAPON_CANNON, buttons: BTN_FIRE })], s.tick);
    const b = s.bolts.find((q) => q.kind === 'cannon')!;
    expect(Math.hypot(...b.vel)).toBeGreaterThan(2 * s.config.weapons.rifle.muzzle);
    expect(b.damage).toBeGreaterThan(5 * s.config.weapons.rifle.damage);
    expect(s.events.some((e) => e.type === 'overheat')).toBe(true);
    let next = -1;
    for (let i = 0; i < 600 && next < 0; i++) {
      step(s, [cmdFor(s, id, { weapon: WEAPON_CANNON, buttons: i % 2 ? BTN_FIRE : 0 })], s.tick);
      if (s.events.some((e) => e.type === 'fire')) next = i;
    }
    expect(Math.abs(next * DT - s.config.weapons.cannon.overheatLock)).toBeLessThan(0.1);
    void p;
  });
  it('Laconic Laser: charges, then streams for half a second, slowed; a full stream kills', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const vid = addPlayer(s, 'human', 'Victim');
    run(s, 20);
    const p = give(s, 'laconic');
    const victim = s.players.find((q) => q.id === vid)!;
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_LACONIC })]);
    const st = s.config.weapons.laconic;
    let firstShot = -1, shots = 0, maxSpeed = 0, hitsOnVictim = 0;
    // aim at the victim (stand-in for "taking the whole stream")
    for (let i = 0; i < Math.round((st.chargeTime + st.burstTime + 0.5) / DT); i++) {
      const aim = aimAt(addScaled(p.pos, localBasis(p.pos).up, 0.7), victim.pos);
      step(s, [cmdFor(s, id, { weapon: WEAPON_LACONIC, moveY: 1, yaw: aim.yaw, pitch: aim.pitch, buttons: BTN_FIRE }), cmdFor(s, vid)], s.tick);
      const n = s.events.filter((e) => e.type === 'fire' && e.owner === id).length;
      if (n && firstShot < 0) firstShot = i;
      shots += n;
      hitsOnVictim += s.events.filter((e) => e.type === 'hit' && e.target === vid).length;
      if (i > 20 && isLaconicBusy(p, s.tick)) maxSpeed = Math.max(maxSpeed, Math.hypot(...p.vel));
    }
    expect(firstShot * DT).toBeGreaterThan(st.chargeTime - 0.05);
    expect(shots).toBeGreaterThanOrEqual(Math.floor(st.burstTime / st.interval) - 1);
    expect(maxSpeed).toBeLessThan(s.config.sprintSpeed * st.chargeMoveScale + 0.5);
    expect(victim.alive).toBe(false);
    expect(hitsOnVictim).toBeGreaterThan(5);
  });
  it('every hit gives a small, tunable kick along the bolt', () => {
    const s = empty();
    addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = s.players[0];
    p.vel = [0, 0, 0];
    const b = localBasis(p.pos);
    s.config.weapons.cannon.knockback = 10;
    spawnBolt(s, -1, 'cannon', add(p.pos, scale(b.axial, -3)), scale(b.axial, 60));
    for (let i = 0; i < 20 && !s.events.some((e) => e.type === 'hit'); i++) step(s, [], s.tick);
    expect(p.vel[2]).toBeGreaterThan(8); // checked on the tick of the hit
  });
  it('melee shoves whoever is in front of you, hard', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const vid = addPlayer(s, 'human', 'V');
    run(s, 20);
    const p = s.players[0];
    const v = s.players.find((q) => q.id === vid)!;
    const b = localBasis(p.pos);
    v.pos = add(p.pos, scale(b.spin, 1.5)); // right in front (yaw 0 = spinward)
    step(s, [cmdFor(s, id, { buttons: BTN_MELEE }), cmdFor(s, vid)], s.tick);
    expect(s.events.some((e) => e.type === 'melee' && e.target === vid)).toBe(true);
    expect(dot(v.vel, b.spin)).toBeGreaterThan(s.config.meleeKnockback * 0.8);
    expect(v.health + v.shield).toBeLessThan(170);
  });
  it('red rifle overheats in fewer shots than the blue one', () => {
    const shotsToOverheat = (weaponItem: string | null, weapon: number) => {
      const s = empty();
      const id = addPlayer(s, 'human', 'P');
      run(s, 20);
      if (weaponItem) give(s, weaponItem);
      run(s, 40, () => [cmdFor(s, id, { weapon })]);
      let shots = 0;
      for (let i = 0; i < 1200; i++) {
        step(s, [cmdFor(s, id, { weapon, buttons: BTN_FIRE })], s.tick);
        shots += s.events.filter((e) => e.type === 'fire').length;
        if (s.events.some((e) => e.type === 'overheat')) return shots;
      }
      return Infinity;
    };
    const blue = shotsToOverheat(null, 0);
    const red = shotsToOverheat('redRifle', WEAPON_RED);
    expect(blue).toBeLessThan(Infinity);
    expect(red).toBeLessThan(blue);
  });
  it("you can't select a weapon you don't own; the hover gun is debug-only", () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    step(s, [cmdFor(s, id, { weapon: WEAPON_LACONIC })], s.tick);
    expect(p.weapon).toBe(0);
    step(s, [cmdFor(s, id, { weapon: WEAPON_HOVER })], s.tick);
    expect(p.weapon).toBe(0);
    s.config.allowHoverGun = true;
    step(s, [cmdFor(s, id, { weapon: WEAPON_HOVER })], s.tick);
    expect(p.weapon).toBe(WEAPON_HOVER);
  });
});

describe('18. pickups, drops and the jetpack', () => {
  it('level pickups are collected by touch, capped, and respawn', () => {
    const s = createState({ seed: 3, props: false });
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const pk = s.pickups.find((q) => q.item === 'sticky')!;
    expect(pk).toBeDefined();
    p.grenades = 1;
    p.pos = [...pk.pos] as Vec3;
    step(s, [], s.tick);
    expect(p.grenades).toBe(4); // refilled to the cap, never above
    expect(s.events.some((e) => e.type === 'pickup' && e.player === id)).toBe(true);
    expect(pk.activeAt).toBe(s.tick - 1 + Math.round(s.config.pickupRespawn / DT));
    p.grenades = 4;
    run(s, Math.round(s.config.pickupRespawn / DT) + 5);
    expect(s.pickups).toContain(pk);
  });
  it('a full item is left on the ground', () => {
    const s = createState({ seed: 3, props: false });
    addPlayer(s, 'human', 'P');
    const p = s.players[0];
    const pk = s.pickups.find((q) => q.item === 'health')!;
    p.pos = [...pk.pos] as Vec3;
    step(s, [], s.tick);
    expect(s.events.some((e) => e.type === 'pickup')).toBe(false);
  });
  it('weapons and grenades drop on death and expire later', () => {
    const s = empty();
    addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = s.players[0];
    applyItem(s.config, p, 'launcher', -1);
    p.mag[WEAPON_LAUNCHER] = 1;
    p.ammo[WEAPON_LAUNCHER] = 2; // 3 rounds in total go into the drop
    p.grenades = 2;
    p.bounceGrenades = 0;
    p.pos = addScaled(p.pos, localBasis(p.pos).up, 5); // die in mid-air: drops land on the floor below
    damagePlayer(s, p, -1, 1e6, 1e6, 'test');
    const items = s.pickups.map((q) => [q.item, q.amount]);
    expect(items).toEqual(expect.arrayContaining([['launcher', 3], ['sticky', 2]]));
    expect(items.length).toBe(2);
    for (const q of s.pickups) expect(Math.abs(Math.hypot(q.pos[0], q.pos[1]) - (s.config.R - 1))).toBeLessThan(0.05);
    run(s, Math.round(s.config.dropLifetime / DT) + 5);
    expect(s.pickups.length).toBe(0);
  });
  it('jetpack: hold jump in the air to climb until the fuel runs out', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = s.players[0];
    applyItem(s.config, p, 'jetpack', -1);
    step(s, [cmdFor(s, id, { buttons: BTN_JUMP })], s.tick); // jump
    let maxH = 0, ticks = 0;
    const height = () => s.config.R - Math.hypot(p.pos[0], p.pos[1]) - 0.9;
    while (p.jetFuel > 0 && ticks < 2000) {
      step(s, [cmdFor(s, id, { buttons: BTN_JUMP })], s.tick);
      maxH = Math.max(maxH, height());
      ticks++;
    }
    expect(Math.abs(ticks * DT - 1 / s.config.jetBurn)).toBeLessThan(0.05);
    // a plain jump peaks at ~3 m; four seconds of thrust gets far higher
    expect(maxH).toBeGreaterThan(20);
    step(s, [cmdFor(s, id, { buttons: BTN_JUMP })], s.tick);
    expect(p.jetting).toBe(false);
  });
});

describe('19. ring size range', () => {
  for (const R of [10, 5000]) {
    it(`R = ${R}: the level fits and play is stable`, () => {
      const s = createState({ seed: 4, config: { R } });
      const id = addPlayer(s, 'human', 'P');
      const bot = addPlayer(s, 'bot', 'B');
      for (const b of s.level.boxes) {
        // how far the box's top reaches above the floor (ramps are buried deep, so measure the top)
        const top = s.config.R - Math.hypot(b.center[0], b.center[1]) + b.half[1] * Math.cos(b.tilt);
        expect(top).toBeLessThan(0.45 * R + 0.5);
      }
      for (const h of [...s.level.wallPos, ...s.level.wallNeg]) expect(h).toBeLessThanOrEqual(0.4 * R);
      run(s, 1200, (st) => [cmdFor(st, id), botInput(st, bot)]);
      const p = s.players.find((q) => q.id === id)!;
      expect(p.pos.every(Number.isFinite)).toBe(true);
      expect(p.grounded).toBe(true);
    });
  }
});

describe('20. levels and campaign', () => {
  it('every level builds; enemies stand on the floor or their lookout', () => {
    for (const def of LEVELS) {
      const { state, localId, botIds } = startLevel(def);
      expect(state.mode).toBe(def.mode);
      expect(state.config.R).toBe(def.config.R);
      if (def.mode === 'campaign') expect(botIds.length).toBe(def.enemies!.length);
      else expect(botIds.length).toBe(def.bots ?? 0);
      run(state, 60, (s) => [cmdFor(s, localId)]);
      for (const p of state.players) {
        expect(p.pos.every(Number.isFinite)).toBe(true);
        expect(p.grounded).toBe(true);
      }
      const snipers = state.players.filter((p) => p.enemyType === 'sniper');
      for (const sn of snipers) expect(state.config.R - Math.hypot(sn.pos[0], sn.pos[1])).toBeGreaterThan(5);
    }
  });
  it('campaign: enemies cannot hurt each other, only you', () => {
    const { state, localId } = startLevel(levelById('c1')!);
    const [a, b] = state.players.filter((p) => p.enemyType);
    const me = state.players.find((p) => p.id === localId)!;
    const hb = b.health + b.shield;
    damagePlayer(state, b, a.id, 50, 50, 'test');
    expect(b.health + b.shield).toBe(hb);
    const hm = me.health + me.shield;
    damagePlayer(state, me, a.id, 50, 50, 'test');
    expect(me.health + me.shield).toBe(hm - 50);
  });
  it('campaign: won when every enemy is dead, no respawns; dropped weapons are loot', () => {
    const { state, localId } = startLevel(levelById('c4')!);
    const heavy = state.players.find((p) => p.enemyType === 'heavy')!;
    for (const e of state.players.filter((p) => p.enemyType)) damagePlayer(state, e, localId, 1e6, 1e6, 'test');
    step(state, [], state.tick);
    expect(state.outcome).toBe('won');
    expect(state.events.some((e) => e.type === 'outcome' && e.outcome === 'won')).toBe(true);
    expect(state.pickups.some((k) => k.item === 'launcher' && k.expireTick > 0)).toBe(true);
    run(state, 600);
    expect(heavy.alive).toBe(false); // stays dead
  });
  it('campaign: lost when you die', () => {
    const { state, localId } = startLevel(levelById('c1')!);
    const me = state.players.find((p) => p.id === localId)!;
    damagePlayer(state, me, -1, 1e6, 1e6, 'test');
    step(state, [], state.tick);
    expect(state.outcome).toBe('lost');
    run(state, 600);
    expect(me.alive).toBe(false);
  });
  it('enemy size scales the hitbox: a bolt that misses you hits a heavy', () => {
    const hitsAt = (size: number) => {
      const s = empty();
      addPlayer(s, 'human', 'P');
      run(s, 20);
      const p = s.players[0];
      p.size = size;
      const b = localBasis(p.pos);
      // a bolt passing 0.7 m from the capsule axis: misses 0.4 + 0.12, hits 0.6 + 0.12
      const from = add(add(p.pos, scale(b.axial, -3)), scale(b.spin, 0.7));
      spawnBolt(s, -1, 'rifle', from, scale(b.axial, 30));
      run(s, 30);
      return p.health + p.shield < s.config.maxHealth + s.config.maxShield;
    };
    expect(hitsAt(1)).toBe(false);
    expect(hitsAt(1.5)).toBe(true);
  });
  it('a campaign level plays out deterministically with enemies attacking you', { timeout: 30000 }, () => {
    const play = () => {
      const { state, localId, botIds } = startLevel(levelById('c1')!);
      // stand within the first grunts' range and let them come
      const me = state.players.find((p) => p.id === localId)!;
      const a = (14 * Math.PI) / 180, R = state.config.R;
      me.pos = [(R - 0.9) * Math.cos(a), (R - 0.9) * Math.sin(a), 0];
      let hitsOnMe = 0;
      for (let i = 0; i < 120 * 40 && state.outcome === 'playing'; i++) {
        step(state, [cmdFor(state, localId), ...botIds.map((b) => botInput(state, b))], state.tick);
        hitsOnMe += state.events.filter((e) => e.type === 'hit' && e.target === localId).length;
      }
      return { bytes: encode(state), hitsOnMe };
    };
    const a = play(), b = play();
    expect(a.hitsOnMe).toBeGreaterThan(0);
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
  });
});

describe('21. aim, shot speed and the Grav Mallet', () => {
  /** Closest a bolt fired with this aim gets to a target moving at its current velocity. */
  const closest = (s: SimState, shooter: number, target: number, kind: 'fuelRod' | 'rifle', yaw: number, pitch: number) => {
    const me = s.players.find((p) => p.id === shooter)!;
    const tg = s.players.find((p) => p.id === target)!;
    me.yaw = yaw; me.pitch = pitch;
    const from = muzzlePoint(me, yaw, pitch);
    const r: Vec3 = [...from] as Vec3;
    const v = launchVelocity(s.config, me, kind, from, yaw, pitch);
    let best = Infinity;
    for (let i = 1; i < 600; i++) {
      advanceFree(r, v, DT, omegaOf(s.config), s.config);
      const t = addScaled(tg.pos, tg.vel, i * DT);
      best = Math.min(best, Math.hypot(r[0] - t[0], r[1] - t[1], r[2] - t[2]));
    }
    return best;
  };
  it('a solved aim allows for the spin and leads a moving target; straight aim misses', () => {
    const s = empty();
    const a = addPlayer(s, 'human', 'A');
    const b = addPlayer(s, 'human', 'B');
    run(s, 20);
    const A = s.players.find((p) => p.id === a)!, B = s.players.find((p) => p.id === b)!;
    // B is 50 m spinward-ish and running across the ring
    const R = s.config.R, ang = Math.atan2(A.pos[1], A.pos[0]) + 50 / R;
    B.pos = [(R - 0.9) * Math.cos(ang), (R - 0.9) * Math.sin(ang), 5];
    B.vel = [0, 0, 6];
    const eye = addScaled(A.pos, localBasis(A.pos).up, 0.7);
    const straight = aimAt(eye, B.pos);
    const solved = solveAim(s, A, B, 'fuelRod');
    const missStraight = closest(s, a, b, 'fuelRod', straight.yaw, straight.pitch);
    const missSolved = closest(s, a, b, 'fuelRod', solved.yaw, solved.pitch);
    expect(missStraight).toBeGreaterThan(3);
    expect(missSolved).toBeLessThan(0.5);
  });
  it('at close range shots barely curve (default speeds)', () => {
    const s = empty();
    const a = addPlayer(s, 'human', 'A');
    const b = addPlayer(s, 'human', 'B');
    run(s, 20);
    const A = s.players.find((p) => p.id === a)!, B = s.players.find((p) => p.id === b)!;
    const R = s.config.R;
    for (const [dAng, dz] of [[10 / R, 0], [-10 / R, 0], [0, 10]]) {
      const ang = Math.atan2(A.pos[1], A.pos[0]) + dAng;
      B.pos = [(R - 0.9) * Math.cos(ang), (R - 0.9) * Math.sin(ang), A.pos[2] + dz];
      B.vel = [0, 0, 0];
      const straight = aimAt(addScaled(A.pos, localBasis(A.pos).up, 0.7), B.pos);
      expect(closest(s, a, b, 'rifle', straight.yaw, straight.pitch)).toBeLessThan(0.6); // incl. the muzzle's 0.2 m offset from the eye
    }
  });
  it('the Grav Mallet hits everyone in front of you, hard, and nobody behind', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const f1 = addPlayer(s, 'human', 'F1'), f2 = addPlayer(s, 'human', 'F2'), bk = addPlayer(s, 'human', 'Back');
    run(s, 20);
    const p = s.players.find((q) => q.id === id)!;
    applyItem(s.config, p, 'hammer', -1);
    const b = localBasis(p.pos);
    const place = (pid: number, along: number, side: number) => {
      const q = s.players.find((x) => x.id === pid)!;
      q.pos = add(add(p.pos, scale(b.spin, along)), scale(b.axial, side));
      q.vel = [0, 0, 0];
      return q;
    };
    const F1 = place(f1, 1.8, -0.9), F2 = place(f2, 1.8, 0.9), BK = place(bk, -1.8, 0);
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_HAMMER })]);
    for (const q of [F1, F2, BK]) { q.pos = place(q.id, q === BK ? -1.8 : 1.8, q === F1 ? -0.9 : q === F2 ? 0.9 : 0).pos; q.vel = [0, 0, 0]; }
    step(s, [cmdFor(s, id, { weapon: WEAPON_HAMMER, buttons: BTN_FIRE })], s.tick);
    for (const q of [F1, F2]) {
      expect(dot(q.vel, b.spin)).toBeGreaterThan(s.config.weapons.hammer.knockback * 0.7);
      expect(q.health + q.shield).toBeLessThan(170 - 80);
    }
    expect(Math.hypot(...BK.vel)).toBeLessThan(1);
    expect(BK.health + BK.shield).toBe(170);
  });
  it('the Grav Mallet also bats loose grenades and knocks bikes', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    run(s, 20);
    const p = s.players[0];
    applyItem(s.config, p, 'hammer', -1);
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_HAMMER })]);
    const b = localBasis(p.pos);
    const g = spawnGrenade(s, 99, addScaled(p.pos, b.spin, 1.5), scale(b.spin, -3), 'bounce');
    const vid = addVehicle(s, addScaled(addScaled(p.pos, b.spin, 2), b.axial, 0.6), 0);
    const bike = s.vehicles.find((v) => v.id === vid)!;
    step(s, [cmdFor(s, id, { weapon: WEAPON_HAMMER, buttons: BTN_FIRE })], s.tick);
    expect(dot(g.vel, b.spin)).toBeGreaterThan(20);
    expect(g.owner).toBe(id);
    expect(dot(bike.vel, b.spin)).toBeGreaterThan(1);
    expect(bike.health).toBeLessThan(bike.maxHealth);
    const ev = s.events.find((e) => e.type === 'melee');
    expect(ev && ev.type === 'melee' && ev.mallet).toBe(true);
  });
});

describe('22. Earth: the no-spin reference level', () => {
  const earth = () => {
    const { state, localId } = startLevel(levelById('s-earth')!);
    state.players = state.players.filter((p) => p.id === localId); // no bots
    return { s: state, id: localId, p: state.players[0] };
  };
  it('does not spin; you weigh exactly 1 g standing still', () => {
    const { s, id, p } = earth();
    expect(omegaOf(s.config)).toBe(0);
    run(s, 240, () => [cmdFor(s, id)]);
    expect(s.frameAngle).toBe(0);
    expect(p.apparentG).toBeCloseTo(1, 2);
  });
  it('a dropped object falls straight down in sqrt(2h/g)', () => {
    const { s } = earth();
    const g = s.config.gravity, R = s.config.R, h = 10;
    const Re = R - GRENADE_RADIUS;
    const gr = spawnGrenade(s, -1, [Re - h, 0, 5], [0, 0, 0]);
    let t = 0;
    while (!gr.stuck && t < 1000) { step(s, [], s.tick); t++; }
    expect(Math.abs(t * DT - Math.sqrt((2 * h) / g))).toBeLessThan(0.02);
    expect(Math.abs(angleOf(gr.pos) * R)).toBeLessThan(0.01); // lands right below
  });
  it('a 45 degree throw lands at v^2/g; a jump peaks at v^2/2g', () => {
    const { s, id, p } = earth();
    const g = s.config.gravity, R = s.config.R, v = 15;
    const Re = R - GRENADE_RADIUS;
    const gr = spawnGrenade(s, -1, [Re, 0, -20], [-v / Math.SQRT2, v / Math.SQRT2, 0]);
    while (!gr.stuck && s.tick < 2000) step(s, [], s.tick);
    expect(Math.abs(angleOf(gr.pos) * R - (v * v) / g)).toBeLessThan(0.1);
    // jump
    run(s, 20, () => [cmdFor(s, id)]);
    const r0 = Math.hypot(p.pos[0], p.pos[1]);
    step(s, [cmdFor(s, id, { buttons: BTN_JUMP })], s.tick);
    let apex = 0;
    for (let i = 0; i < 400; i++) { step(s, [cmdFor(s, id)], s.tick); apex = Math.max(apex, r0 - Math.hypot(p.pos[0], p.pos[1])); }
    expect(Math.abs(apex - s.config.jumpSpeed ** 2 / (2 * g))).toBeLessThan(0.05);
  });
  it('the arena is walled in and the Boot Camp level plays', () => {
    const { s } = earth();
    expect(s.level.boxes.filter((b) => b.kind === 'wall').length).toBe(2);
    for (const sp of s.level.spawns) expect(Math.abs(sp.angle * s.config.R)).toBeLessThan(s.config.arena / 2);
    const { state, localId, botIds } = startLevel(levelById('c0')!);
    expect(botIds.length).toBe(3);
    run(state, 600, (st) => [cmdFor(st, localId), ...botIds.map((b) => botInput(st, b))]);
    for (const q of state.players) expect(q.pos.every(Number.isFinite)).toBe(true);
  });
});

describe('23. per-level world settings', () => {
  it('the hazy ring has air that slows bolts; it does not leak into the next level', () => {
    // the same shot in air and in vacuum: drag takes a good chunk of its speed
    const speedAfter = (id: string) => {
      const st = startLevel(levelById(id)!).state;
      const b = spawnBolt(st, -1, 'rifle', [st.config.R - 5, 0, 0], [0, 80, 0]);
      run(st, 60);
      return Math.hypot(...b.vel);
    };
    const inAir = speedAfter('s-hazy'), inVacuum = speedAfter('s-standard');
    expect(inVacuum - inAir).toBeGreaterThan(5); // ~7 m/s slower after half a second
    const s = startLevel(levelById('s-hazy')!).state;
    const next = startLevel(levelById('s-standard')!, { ...s.config });
    expect(next.state.config.dragType).toBe('none');
    const fromEarth = startLevel(levelById('s-standard')!, { ...startLevel(levelById('s-earth')!).state.config });
    expect([fromEarth.state.config.spin, fromEarth.state.config.gravity, fromEarth.state.config.arena]).toEqual([true, 0, 0]);
  });
});

describe('24. terrain: hills and the sphere band', () => {
  it('you can stand on a hilltop; the floor really is up there', () => {
    const { state, localId } = startLevel(levelById('s-hills')!);
    const s = state;
    s.players = s.players.filter((p) => p.id === localId);
    const p = s.players[0];
    const hill = [...s.level.terrain!.hills].sort((a, b) => b.height - a.height)[0];
    const R = s.config.R;
    const r0 = R - hill.height - 3; // drop onto the peak from 3 m above
    p.pos = [r0 * Math.cos(hill.angle), r0 * Math.sin(hill.angle), hill.z];
    p.vel = [0, 0, 0];
    run(s, 240, () => [cmdFor(s, localId)]);
    expect(p.grounded).toBe(true);
    const height = R - Math.hypot(p.pos[0], p.pos[1]) - 0.9;
    expect(height).toBeGreaterThan(hill.height * 0.8);
  });
  it('on the sphere band you weigh g cos^2(latitude), and the edge rises like a hill', () => {
    const { state, localId } = startLevel(levelById('s-bowl')!);
    const s = state;
    s.players = s.players.filter((p) => p.id === localId);
    const p = s.players[0];
    const R = s.config.R, z = 40, lat = Math.asin(z / R);
    const fr = Math.sqrt(R * R - z * z); // floor radius there
    expect(R - fr).toBeGreaterThan(10); // the floor has climbed > 10 m toward the axis
    const ang = 0.3;
    // stand there (capsule centre 0.9 m in from the floor, along the local "up")
    p.pos = [(fr - 0.9) * Math.cos(ang), (fr - 0.9) * Math.sin(ang), z + 0.9 * Math.sin(lat)];
    p.vel = [0, 0, 0];
    run(s, 360, () => [cmdFor(s, localId)]);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.apparentG - Math.cos(lat) ** 2)).toBeLessThan(0.08);
  });
  it('every terrain level builds and its players settle on the ground', () => {
    for (const id of ['s-hills', 's-bowl', 's-wide', 'c6', 's-sphere', 's-ridge']) {
      const { state, localId } = startLevel(levelById(id)!);
      run(state, 120, (st) => [cmdFor(st, localId)]);
      for (const p of state.players) {
        expect(p.pos.every(Number.isFinite)).toBe(true);
        expect(p.grounded).toBe(true);
      }
    }
  });
});

describe('25. planet below: a pull fixed to the stars', () => {
  it('standing still, your weight swings between g - pull and g + pull once per spin', () => {
    const { state, localId } = startLevel(levelById('s-planet')!);
    const s = state;
    s.players = s.players.filter((p) => p.id === localId);
    const p = s.players[0];
    const ratio = s.config.planetPull / s.config.g;
    const T = (2 * Math.PI) / omegaOf(s.config);
    run(s, 120, () => [cmdFor(s, localId)]);
    let lo = Infinity, hi = 0;
    for (let i = 0; i < Math.round(T / DT); i++) {
      step(s, [cmdFor(s, localId)], s.tick);
      lo = Math.min(lo, p.apparentG);
      hi = Math.max(hi, p.apparentG);
    }
    expect(p.grounded).toBe(true);
    expect(Math.abs(hi - (1 + ratio))).toBeLessThan(0.08);
    expect(Math.abs(lo - (1 - ratio))).toBeLessThan(0.08);
  });
  it('the trajectory preview follows the turning pull', () => {
    const { state, localId } = startLevel(levelById('s-planet')!);
    run(state, 30, (st) => [cmdFor(st, localId)]);
    const pred = predictTrajectory(state, localId, 'grenade', 0, 0.4);
    const g = spawnGrenade(state, localId, muzzlePoint(state.players.find((p) => p.id === localId)!, 0, 0.4, true),
      launchVelocity(state.config, state.players.find((p) => p.id === localId)!, 'grenade', muzzlePoint(state.players.find((p) => p.id === localId)!, 0, 0.4, true), 0, 0.4));
    state.players = state.players.filter((p) => p.id === localId);
    for (let i = 0; i < 2000 && !g.stuck; i++) step(state, [cmdFor(state, localId, { yaw: 0, pitch: 0.4 })], state.tick);
    expect(pred.hit).not.toBeNull();
    expect(Math.hypot(g.pos[0] - pred.hit![0], g.pos[1] - pred.hit![1], g.pos[2] - pred.hit![2])).toBeLessThan(0.6);
  });
});

describe('26. hover-bikes', () => {
  const bikeWorld = () => {
    const { state, localId } = startLevel(levelById('s-large')!);
    state.players = state.players.filter((p) => p.id === localId);
    state.level.boxes = []; // an open floor, so the tests measure the bike and not the layout
    const p = state.players[0];
    const v = state.vehicles[0];
    // stand next to the first bike
    p.pos = addScaled(v.pos, localBasis(v.pos).up, 0.2);
    p.vel = [0, 0, 0];
    return { s: state, id: localId, p, v };
  };
  it('only bigger rings have bikes', () => {
    expect(startLevel(levelById('s-standard')!).state.vehicles.length).toBe(0);
    expect(startLevel(levelById('s-large')!).state.vehicles.length).toBeGreaterThan(3);
    expect(startLevel(levelById('s-hills')!).state.vehicles.length).toBeGreaterThan(0);
  });
  it('E gets on and off; the throttle gets you moving fast, frictionless', () => {
    const { s, id, p, v } = bikeWorld();
    step(s, [cmdFor(s, id, { buttons: BTN_USE })], s.tick);
    expect(p.vehicle).toBe(v.id);
    expect(v.driver).toBe(id);
    const yaw = v.homeYaw;
    run(s, 120 * 3, () => [cmdFor(s, id, { moveY: 1, yaw })]);
    expect(Math.hypot(...v.vel)).toBeGreaterThan(25);
    expect(dist(p.pos, v.pos)).toBeLessThan(1.5); // the rider rides along
    // coast: barely slows (frictionless; just a little damping)
    const v0 = Math.hypot(...v.vel);
    run(s, 60, () => [cmdFor(s, id, { yaw })]);
    expect(Math.hypot(...v.vel)).toBeGreaterThan(v0 * 0.85);
    step(s, [cmdFor(s, id, { yaw, buttons: BTN_USE })], s.tick);
    expect(p.vehicle).toBe(-1);
    expect(v.driver).toBe(-1);
  });
  it('slamming into a wall hurts the bike (not the rider), and it bounces', () => {
    const { s, id, p, v } = bikeWorld();
    step(s, [cmdFor(s, id, { buttons: BTN_USE })], s.tick);
    // hurl it across the ring at the rim wall at 35 m/s
    v.vel = [0, 0, 35 * Math.sign(-v.pos[2] || 1) * -1];
    v.vel = [0, 0, v.pos[2] > 0 ? 35 : -35];
    const hp0 = v.health, me0 = p.health + p.shield;
    let bounced = false;
    for (let i = 0; i < 240; i++) {
      step(s, [cmdFor(s, id)], s.tick);
      if (v.vel[2] * (v.pos[2] > 0 ? 1 : -1) < -10) bounced = true;
    }
    expect(v.health).toBeLessThan(hp0);
    expect(v.alive).toBe(true); // tough enough to survive one big crash
    expect(p.health + p.shield).toBe(me0);
    expect(bounced).toBe(true);
  });
  it('landing a big jump does not hurt the bike or the rider', () => {
    const { s, id, p, v } = bikeWorld();
    step(s, [cmdFor(s, id, { buttons: BTN_USE })], s.tick);
    v.pos = addScaled(v.pos, localBasis(v.pos).up, 15);
    v.vel = scale(localBasis(v.pos).up, -12); // ~20 m/s coming down
    const hp0 = v.health, me0 = p.health + p.shield;
    run(s, 120 * 3, () => [cmdFor(s, id)]);
    expect(v.health).toBe(hp0);
    expect(p.health + p.shield).toBe(me0);
  });
  it('running someone over hurts them and sends them flying', () => {
    const { s, id, v } = bikeWorld();
    const vid = addPlayer(s, 'human', 'Pedestrian');
    const ped = s.players.find((q) => q.id === vid)!;
    step(s, [cmdFor(s, id, { buttons: BTN_USE })], s.tick);
    const b = localBasis(v.pos);
    ped.pos = addScaled(add(v.pos, scale(b.axial, 6)), b.up, 0.1);
    ped.vel = [0, 0, 0];
    v.vel = scale(b.axial, 20);
    let hurt = false;
    for (let i = 0; i < 120 && !hurt; i++) {
      step(s, [cmdFor(s, id, { yaw: Math.PI / 2 }), cmdFor(s, vid)], s.tick);
      hurt = s.events.some((e) => e.type === 'hit' && e.target === vid);
    }
    expect(hurt).toBe(true);
    expect(Math.hypot(...ped.vel)).toBeGreaterThan(8);
  });
  it('a destroyed bike explodes, throws the rider off, and comes back later', () => {
    const { s, id, p, v } = bikeWorld();
    step(s, [cmdFor(s, id, { buttons: BTN_USE })], s.tick);
    p.maxHealth = p.health = 1e6;
    damageVehicle(s, v, -1, 1e6);
    expect(v.alive).toBe(false);
    expect(p.vehicle).toBe(-1);
    expect(s.events.some((e) => e.type === 'vehicleDestroyed')).toBe(true);
    expect(s.explosions.length).toBeGreaterThan(0);
    p.pos = addScaled(p.pos, localBasis(p.pos).spin, 20); // get off the spot
    run(s, Math.round(s.config.bikeRespawn / DT) + 10, () => [cmdFor(s, id)]);
    expect(v.alive).toBe(true);
    expect(v.health).toBe(v.maxHealth);
  });
  it('shots and sticky grenades work on bikes', () => {
    const { s, v } = bikeWorld();
    const hp0 = v.health;
    const b = localBasis(v.pos);
    spawnBolt(s, -1, 'cannon', add(v.pos, scale(b.axial, -6)), scale(b.axial, 200));
    run(s, 10);
    expect(v.health).toBeLessThan(hp0);
    const g = spawnGrenade(s, -1, add(v.pos, scale(b.axial, -4)), scale(b.axial, 30));
    run(s, 20);
    expect(g.stuck?.kind).toBe('vehicle');
  });
});

describe('27. enemy AI: cover and ramps', () => {
  const aiWorld = () => {
    const s = createState({ props: false, dummies: false, pickups: false, vehicles: 0 });
    s.players = [];
    const tid = addPlayer(s, 'human', 'Target');
    const target = s.players.find((p) => p.id === tid)!;
    target.maxHealth = target.health = 1e6; // just a target
    const eid = addPlayer(s, 'bot', 'Enemy');
    const e = s.players.find((p) => p.id === eid)!;
    return { s, tid, target, eid, e };
  };
  const above = (s: SimState, p: { pos: Vec3 }) => s.config.R - Math.hypot(p.pos[0], p.pos[1]);
  const standOn = (s: SimState, angle: number, z: number): Vec3 => {
    const r = s.config.R - 0.9;
    return [r * Math.cos(angle), r * Math.sin(angle), z];
  };

  it('a soldier with low shields gets a box between itself and you, and holds fire', () => {
    const { s, tid, target, eid, e } = aiWorld();
    const box = s.level.boxes.find((b) => b.kind === 'cover' && b.tilt === 0 && Math.abs(b.center[2]) < 8)!;
    expect(box).toBeTruthy();
    e.enemyType = 'soldier';
    e.maxShield = 70;
    e.shield = 10;
    // you: 18 m spinward of the box; the soldier: out in the open, 5 m across from it
    target.pos = standOn(s, box.angle + 18 / s.config.R, box.center[2]);
    e.pos = standOn(s, box.angle + 2 / s.config.R, box.center[2] + 6);
    run(s, 20, (st) => [cmdFor(st, tid)]);
    let shots = 0;
    for (let i = 0; i < 120 * 3; i++) {
      e.lastDamageTick = s.tick; // keep the shields from recharging
      step(s, [cmdFor(s, tid), botInput(s, eid)], s.tick);
      shots += s.events.filter((ev) => ev.type === 'fire' && ev.owner === eid).length;
    }
    expect(shots).toBe(0);
    // the box is now between you: sample the straight line for a point inside it
    let blocked = false;
    for (let k = 1; k < 40 && !blocked; k++) {
      const q = add(target.pos, scale(add(e.pos, scale(target.pos, -1)), k / 40));
      blocked = levelSdf(s.level, s.config, q).d < 0;
    }
    expect(blocked).toBe(true);
  });

  it('an enemy takes the ramp up to you on a lookout (from the side: round to the front first)', { timeout: 20000 }, () => {
    const { s, tid, target, eid, e } = aiWorld();
    expect(s.level.stairTops.length).toBeGreaterThan(0);
    e.enemyType = 'soldier';
    target.pos = s.level.stairTops[0];
    run(s, 60, (st) => [cmdFor(st, tid)]);
    const h = above(s, target);
    expect(h).toBeGreaterThan(4);
    // start on the floor 15 m off to the side of the lookout
    const a = angleOf(target.pos);
    e.pos = standOn(s, a - 15 / s.config.R, Math.max(-12, Math.min(12, target.pos[2] + 10)));
    let best = 0;
    for (let i = 0; i < 120 * 20 && best < h - 1.5; i++) {
      step(s, [cmdFor(s, tid), botInput(s, eid)], s.tick);
      if (e.grounded) best = Math.max(best, above(s, e));
    }
    expect(best).toBeGreaterThan(h - 1.5);
    expect(e.alive).toBe(true);
  });
});

describe('28. reloads carry on when you switch weapons', () => {
  it('an emptied fuel rod launcher is loaded again when you come back to it', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    applyItem(s.config, p, 'launcher', -1);
    run(s, 60, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER })]);
    // empty the magazine (auto-reload starts), then switch away straight away
    for (let i = 0; i < 400 && p.mag[WEAPON_LAUNCHER] > 0; i++) step(s, [cmdFor(s, id, { weapon: WEAPON_LAUNCHER, buttons: i % 2 ? BTN_FIRE : 0 })], s.tick);
    run(s, 2, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER })]);
    expect(p.reloadUntil).toBeGreaterThan(s.tick);
    run(s, Math.round(s.config.weapons.launcher.reloadTime / DT) + 10, () => [cmdFor(s, id, { weapon: 0 })]);
    expect(p.mag[WEAPON_LAUNCHER]).toBe(s.config.weapons.launcher.magSize);
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER })]);
    expect(p.reloadUntil).toBe(0);
    const before = p.mag[WEAPON_LAUNCHER];
    run(s, 2, () => [cmdFor(s, id, { weapon: WEAPON_LAUNCHER, buttons: BTN_FIRE })]);
    expect(p.mag[WEAPON_LAUNCHER]).toBe(before - 1);
  });
});

describe('29. rockets', () => {
  /** Rotating-frame vector -> inertial, at this frame angle. */
  const toInertial = (v: Vec3, fa: number): Vec3 => [Math.cos(fa) * v[0] - Math.sin(fa) * v[1], Math.sin(fa) * v[0] + Math.cos(fa) * v[1], v[2]];
  it('the nose keeps its direction relative to the stars; the motor adds thrust x burn time, inertially', () => {
    const s = empty({ R: 1000 });
    const w = omegaOf(s.config);
    run(s, 37); // start at an odd frame angle
    const r: Vec3 = [500, 0, 0];
    const atRest: Vec3 = [w * r[1], -w * r[0], 0]; // at rest in the inertial frame
    const nose: Vec3 = [0.6, 0.8, 0];
    const b = spawnBolt(s, -1, 'rocket', r, atRest, nose);
    run(s, 1); // a bolt first moves on the tick after it's fired
    const nose0 = toInertial(nose, s.frameAngle);
    const ws = s.config.weapons.rocket;
    run(s, Math.round(ws.burnTime / DT) + 20);
    expect(s.bolts).toContain(b);
    expect(s.tick).toBeGreaterThan(b.burnUntil);
    const n1 = toInertial(b.dir!, s.frameAngle);
    for (let i = 0; i < 3; i++) expect(n1[i]).toBeCloseTo(nose0[i], 9);
    // inertial velocity: v_rot + omega x r, rotated into the star frame
    const vIn = toInertial([b.vel[0] - w * b.pos[1], b.vel[1] + w * b.pos[0], b.vel[2]], s.frameAngle);
    const dv = ws.thrust * Math.round(ws.burnTime / DT) * DT;
    for (let i = 0; i < 3; i++) expect(vIn[i]).toBeCloseTo(nose0[i] * dv, 1);
  });
  it('fired from the hip it leaves slowly along your aim, then accelerates; it explodes on impact', () => {
    const s = empty();
    const id = addPlayer(s, 'human', 'P');
    const p = s.players[0];
    applyItem(s.config, p, 'rocket', -1);
    run(s, 40, () => [cmdFor(s, id, { weapon: WEAPON_ROCKET, pitch: 0.3 })]);
    step(s, [cmdFor(s, id, { weapon: WEAPON_ROCKET, pitch: 0.3, buttons: BTN_FIRE })], s.tick);
    const b = s.bolts.find((q) => q.kind === 'rocket')!;
    expect(b).toBeTruthy();
    const v0 = Math.hypot(...b.vel);
    run(s, 60, () => [cmdFor(s, id, { weapon: WEAPON_ROCKET, pitch: 0.3 })]);
    expect(s.bolts).toContain(b);
    expect(Math.hypot(...b.vel)).toBeGreaterThan(v0 + 25);
    let boom = false;
    for (let i = 0; i < 600 && !boom; i++) {
      step(s, [cmdFor(s, id, { weapon: WEAPON_ROCKET })], s.tick);
      boom = s.events.some((e) => e.type === 'explode');
    }
    expect(boom).toBe(true);
  });
  it('a seeker steers onto someone off to the side; a plain rocket on the same line misses', () => {
    const shoot = (kind: 'seeker' | 'rocket') => {
      const s = empty({ R: 1000, halfWidth: 40 });
      const a = addPlayer(s, 'human', 'A'), t = addPlayer(s, 'human', 'T');
      run(s, 10);
      const A = s.players.find((q) => q.id === a)!, T = s.players.find((q) => q.id === t)!;
      const R = s.config.R;
      const at = (ang: number, z: number): Vec3 => [(R - 0.9) * Math.cos(ang), (R - 0.9) * Math.sin(ang), z];
      A.pos = at(0, 0); T.pos = at(35 / R, 9);
      A.vel = [0, 0, 0]; T.vel = [0, 0, 0];
      T.maxHealth = T.health = 1e6;
      const b = localBasis(A.pos);
      const from = addScaled(A.pos, b.up, 0.6);
      spawnBolt(s, a, kind, from, scale(b.spin, 15), b.spin);
      let hit = false;
      for (let i = 0; i < 400 && !hit; i++) {
        step(s, [], s.tick);
        hit = s.events.some((e) => e.type === 'hit' && e.target === t);
      }
      return hit;
    };
    expect(shoot('seeker')).toBe(true);
    expect(shoot('rocket')).toBe(false);
  });
  it('enough seeker hits in quick succession supercombine; spread out, they do not', () => {
    const pelt = (gapTicks: number) => {
      const s = empty();
      const a = addPlayer(s, 'human', 'A'), t = addPlayer(s, 'human', 'T');
      run(s, 20);
      const T = s.players.find((q) => q.id === t)!;
      T.maxHealth = T.health = 1e6;
      let combos = 0;
      for (let i = 0; i < s.config.comboHits; i++) {
        const b = localBasis(T.pos);
        spawnBolt(s, a, 'seeker', addScaled(T.pos, b.spin, -2), scale(b.spin, 30), b.spin);
        for (let k = 0; k < gapTicks; k++) {
          step(s, [], s.tick);
          combos += s.events.filter((e) => e.type === 'supercombine').length;
          T.vel = [0, 0, 0];
        }
      }
      return combos;
    };
    expect(pelt(12)).toBe(1);
    expect(pelt(120)).toBe(0);
  });
});

describe('30. inside a sphere, and the ridge', () => {
  const solo = (id: string) => {
    const { state, localId } = startLevel(levelById(id)!);
    state.players = state.players.filter((p) => p.id === localId);
    state.level.boxes = [];
    return { s: state, id: localId, p: state.players[0] };
  };
  /** Put the player on the sphere's floor at this latitude. */
  const onSphere = (s: SimState, p: { pos: Vec3; vel: Vec3 }, lat: number) => {
    const R = s.config.R;
    const r = R - 0.95; // along the sphere's radius (the floor normal there)
    p.pos = [r * Math.cos(lat), 0, r * Math.sin(lat)];
    p.vel = [0, 0, 0];
  };
  it('sphere: at 30 degrees you stand in g cos^2(lat); at 65 degrees you slide down toward the equator', () => {
    const { s, id, p } = solo('s-sphere');
    onSphere(s, p, Math.PI / 6);
    run(s, 240, () => [cmdFor(s, id)]);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.apparentG - 0.75)).toBeLessThan(0.08);
    onSphere(s, p, (65 * Math.PI) / 180);
    const z0 = p.pos[2];
    run(s, 480, () => [cmdFor(s, id)]);
    expect(p.pos[2]).toBeLessThan(z0 - 5);
    expect(p.alive).toBe(true);
  });
  it('sphere: the poles are closed, and near them you are almost weightless', () => {
    const { s, id, p } = solo('s-sphere');
    const R = s.config.R;
    // a ball dropped near the pole drifts, very slowly, and never leaves the sphere
    p.pos = [6, 0, R - 8];
    p.vel = [0, 0, 6]; // straight at the pole
    let maxR = 0;
    for (let i = 0; i < 120 * 20; i++) {
      step(s, [cmdFor(s, id)], s.tick);
      maxR = Math.max(maxR, Math.hypot(...p.pos));
    }
    expect(p.alive).toBe(true);
    expect(maxR).toBeLessThan(R + 0.5);
  });
  it('ridge: half the weight on the crest; on the 40-degree flank the floor carries g cos(slope)', () => {
    const { s, id, p } = solo('s-ridge');
    const R = s.config.R;
    const stand = (z: number) => {
      const h = s.config.ridgeHeight; // crest height at z = 0; near the walls the floor is at R
      const r = z === 0 ? R - h - 0.9 : R - 0.9 - 3;
      p.pos = [r, 0, z];
      p.vel = [0, 0, 0];
      run(s, 360, () => [cmdFor(s, id)]);
      return p.apparentG;
    };
    expect(Math.abs(stand(0) - 0.5)).toBeLessThan(0.05);
    expect(p.grounded).toBe(true);
    const z = s.config.halfWidth - 3;
    const g = stand(z);
    expect(p.grounded).toBe(true);
    const t = terrainAt(s.level, s.config, 0, z);
    const expected = ((R - t.h) / R) * Math.cos(Math.atan(Math.abs(t.dhdz)));
    expect(Math.abs(g - expected)).toBeLessThan(0.03);
  });
});

describe('31. silly worlds: holes, decks and tubes', () => {
  const solo = (id: string) => {
    const { state, localId } = startLevel(levelById(id)!);
    state.players = state.players.filter((p) => p.id === localId);
    return { s: state, id: localId, p: state.players[0] };
  };
  const place = (p: { pos: Vec3; vel: Vec3 }, angle: number, r: number, z: number) => {
    p.pos = [r * Math.cos(angle), r * Math.sin(angle), z];
    p.vel = [0, 0, 0];
  };
  it('holes: step over one and the spin flings you out into space; beside it you stand', () => {
    const { s, id, p } = solo('s-swiss');
    const h = s.level.holes![0];
    expect(s.level.holes!.length).toBeGreaterThan(8);
    expect(levelSdf(s.level, s.config, [s.config.R + 1, 0, 0].map((x, i) => i < 2 ? x : h.z) as Vec3).d).toBeDefined();
    place(p, h.angle, s.config.R - 0.9, h.z);
    let died = false;
    for (let i = 0; i < 120 * 6 && !died; i++) { step(s, [cmdFor(s, id)], s.tick); died = !p.alive; }
    expect(died).toBe(true);
    const { s: s2, id: id2, p: p2 } = solo('s-swiss');
    const h2 = s2.level.holes![0];
    place(p2, h2.angle + (h2.halfArc + 1.5) / s2.config.R, s2.config.R - 0.9, h2.z);
    run(s2, 240, () => [cmdFor(s2, id2)]);
    expect(p2.alive).toBe(true);
    expect(p2.grounded).toBe(true);
  });
  it('double decker: you can stand on the upper deck (in less g), and it blocks shots from below', () => {
    const { s, id, p } = solo('s-decks');
    const dk = s.level.decks![0];
    // somewhere on the deck away from its holes
    let a = 0;
    while (dk.holes.some((h) => Math.abs(Math.atan2(Math.sin(a - h.angle), Math.cos(a - h.angle))) * s.config.R < h.halfArc + 4)) a += 0.05;
    s.level.boxes = [];
    place(p, a, dk.r - 0.9, 0);
    run(s, 240, () => [cmdFor(s, id)]);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.apparentG - dk.r / s.config.R)).toBeLessThan(0.03);
    // a bolt fired straight up from the lower floor stops at the deck
    const from: Vec3 = [(s.config.R - 1.5) * Math.cos(a), (s.config.R - 1.5) * Math.sin(a), 3];
    const b = spawnBolt(s, -1, 'cannon', from, scale(localBasis(from).up, 200));
    run(s, 20, () => [cmdFor(s, id)]);
    expect(s.bolts).not.toContain(b);
    expect(s.events.length).toBeGreaterThanOrEqual(0);
  });
  it('an enemy follows you up a ramp onto the deck', { timeout: 20000 }, () => {
    const { state: s, localId } = startLevel(levelById('s-decks')!);
    s.players = s.players.filter((p) => p.id === localId);
    const me = s.players[0];
    me.maxHealth = me.health = 1e6;
    const eid = addPlayer(s, 'bot', 'E');
    const e = s.players.find((q) => q.id === eid)!;
    e.enemyType = 'soldier';
    const dk = s.level.decks![0];
    const ramp = dk.holes[0];
    // you: on the deck just past the top of the first ramp; the enemy: on the floor below, beside it
    const R = s.config.R;
    const dir = 1; // the first deck ramp climbs spinward
    place(me, ramp.angle + dir * (ramp.halfArc + 6) / R, dk.r - 0.9, ramp.z);
    place(e, ramp.angle - dir * 4 / R, R - 0.9, ramp.z + (ramp.z > 0 ? -7 : 7));
    let up = false;
    for (let i = 0; i < 120 * 25 && !up; i++) {
      step(s, [cmdFor(s, localId), botInput(s, eid)], s.tick);
      up = e.grounded && Math.hypot(e.pos[0], e.pos[1]) < dk.r;
    }
    expect(up).toBe(true);
  });
  it('inside a torus: the floor curves up into a ceiling; nothing gets out', () => {
    const { s, id, p } = solo('s-torus');
    s.level.boxes = [];
    const a = s.config.tubeRadius, R = s.config.R;
    expect(levelSdf(s.level, s.config, [R - a, 0, 0]).d).toBeCloseTo(a, 6); // the tube's centre line
    expect(levelSdf(s.level, s.config, [R - 2 * a + 1, 0, 0]).d).toBeCloseTo(1, 6); // just under the ceiling
    run(s, 120, () => [cmdFor(s, id)]);
    expect(p.grounded).toBe(true);
    // a bolt fired straight up hits the ceiling, it doesn't fly off
    const b = spawnBolt(s, -1, 'rifle', addScaled(p.pos, localBasis(p.pos).up, 2), scale(localBasis(p.pos).up, 80));
    let hit = false;
    for (let i = 0; i < 120 && !hit; i++) { step(s, [cmdFor(s, id)], s.tick); hit = !s.bolts.includes(b); }
    expect(hit).toBe(true);
  });
  it('the log: stand on top in 1 g; too far down the side and you slide off into space', () => {
    const { s, id, p } = solo('s-log');
    s.level.boxes = [];
    const a = s.config.tubeRadius, R = s.config.R;
    run(s, 120, () => [cmdFor(s, id)]);
    place(p, 0, R - 0.9, 0);
    run(s, 240, () => [cmdFor(s, id)]);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.apparentG - 1)).toBeLessThan(0.05);
    // 60 degrees round the tube: too steep to stand on
    const lat = Math.PI / 3, rc = R + a;
    place(p, 0, rc - (a + 0.9) * Math.cos(lat), (a + 0.9) * Math.sin(lat));
    let died = false;
    for (let i = 0; i < 120 * 10 && !died; i++) { step(s, [cmdFor(s, id)], s.tick); died = !p.alive; }
    expect(died).toBe(true);
  });
  it('the half-pipe: over the lip there is nothing', () => {
    const { s, id, p } = solo('s-halfpipe');
    const a = s.config.tubeRadius, R = s.config.R;
    place(p, 0, R - a - 0.5, a + s.config.wallThickness + 1.5); // just outside a lip
    let died = false;
    for (let i = 0; i < 120 * 10 && !died; i++) { step(s, [cmdFor(s, id)], s.tick); died = !p.alive; }
    expect(died).toBe(true);
  });
});
