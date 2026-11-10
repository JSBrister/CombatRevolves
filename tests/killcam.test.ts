import { describe, expect, it } from 'vitest';
import { DT, damagePlayer, levelById, spawnBolt, startLevel, step, type SimState } from '../src/sim';
import { KillCam } from '../src/client/killcam';

describe('kill cam', () => {
  const setup = () => {
    const { state, localId, botIds } = startLevel(levelById('s-standard')!, {}, { bots: [1] });
    const kc = new KillCam();
    kc.enabled = true;
    const tick = (n: number) => { for (let i = 0; i < n; i++) { step(state, [], state.tick); kc.record(state); } };
    return { s: state, me: state.players.find((p) => p.id === localId)!, bot: state.players.find((p) => p.id === botIds[0])!, kc, tick };
  };
  it('replays the seconds before your death, after a moment, from a camera that turns backward with the spin', () => {
    const { s, me, bot, kc, tick } = setup();
    tick(400);
    // a shot on its way
    const b = spawnBolt(s, bot.id, 'cannon', [...bot.pos], [0, 0, 1]);
    b.expireTick = s.tick + 1e6;
    tick(30);
    damagePlayer(s, me, bot.id, 1e4, 1e4, 'cannon');
    kc.onDeath(me.id, bot.id);
    expect(kc.active).toBe(false); // (waits for the aftermath)
    tick(60);
    expect(kc.active).toBe(true);
    const shots: { eye: number[]; fa: number; tick: number }[] = [];
    let f;
    while ((f = kc.next(DT, s))) shots.push({ eye: f.eye, fa: f.frameAngle, tick: f.state.tick });
    expect(kc.active).toBe(false);
    const secs = (shots[shots.length - 1].tick - shots[0].tick) * DT;
    expect(secs).toBeGreaterThan(2.2);
    expect(secs).toBeLessThan(2.8);
    // the camera stays put relative to the stars: in the station's frame it turns by minus the spin
    const toStars = (e: number[], fa: number) => [Math.cos(fa) * e[0] - Math.sin(fa) * e[1], Math.sin(fa) * e[0] + Math.cos(fa) * e[1], e[2]];
    const a = toStars(shots[0].eye, shots[0].fa), z = toStars(shots[shots.length - 1].eye, shots[shots.length - 1].fa);
    expect(Math.hypot(a[0] - z[0], a[1] - z[1], a[2] - z[2])).toBeLessThan(1e-6);
    expect(Math.hypot(shots[0].eye[0] - shots[shots.length - 1].eye[0], shots[0].eye[1] - shots[shots.length - 1].eye[1])).toBeGreaterThan(1); // (but it moved, in the station)
  });
  it('can be turned off, and a new level forgets what it saw', () => {
    const { me, bot, kc, tick } = setup();
    kc.setEnabled(false);
    tick(300);
    kc.onDeath(me.id, bot.id);
    tick(100);
    expect(kc.active).toBe(false);
    kc.setEnabled(true);
    kc.clear();
    kc.onDeath(me.id, bot.id); // (nothing recorded)
    tick(100);
    expect(kc.active).toBe(false);
  });
  void ({} as SimState);
});
