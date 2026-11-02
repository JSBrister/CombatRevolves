import { describe, expect, it } from 'vitest';
import {
  BTN_FIRE, BTN_JUMP, BTN_SPRINT, DT, PLAYER_HALF_SEG, PLAYER_RADIUS, GRENADE_RADIUS,
  addPlayer, addProp, botInput, createState, decode, detonate, encode, falloff, hash01, integrate,
  jacobi, knockDir, localBasis, omegaOf, propagateAnalytic, restore, snapshot, spawnBolt, spawnGrenade,
  step, viewVectors, muzzlePoint, type InputCmd, type SimState, type Vec3,
} from '../src/sim';

const empty = (config = {}) => createState({ obstacles: false, props: false, dummies: false, config });
const run = (s: SimState, n: number, inputs: (s: SimState) => InputCmd[] = () => []) => {
  for (let i = 0; i < n; i++) step(s, inputs(s), s.tick);
};
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
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
    for (let i = 0; i < 3; i++) expect(b.launchVel[i]).toBeCloseTo(p.vel[i] + s.config.muzzleRifle * aim[i], 12);
    expect(Math.hypot(...b.vel)).toBeGreaterThan(s.config.muzzleRifle + 5);
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
      s.config.muzzleRifle = Math.hypot(...want);
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
