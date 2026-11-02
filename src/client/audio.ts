// Placeholder sounds, synthesized with WebAudio (no audio assets).

export class Sfx {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  volume = 0.35;

  unlock() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number) {
    const c = this.ctx, m = this.master;
    if (!c || !m || gain < 0.01) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), c.currentTime + dur);
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g).connect(m);
    o.start();
    o.stop(c.currentTime + dur);
  }

  private noise(dur: number, gain: number, lp: number) {
    const c = this.ctx, m = this.master;
    if (!c || !m || gain < 0.01) return;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(m);
    src.start();
  }

  /** attenuation from distance in metres */
  static att(d: number) {
    return 1 / (1 + d / 15);
  }

  shot(kind: string, d: number) {
    const a = Sfx.att(d);
    if (kind === 'rifle') this.tone('square', 900, 260, 0.09, 0.18 * a);
    else if (kind === 'pistol') this.tone('sawtooth', 1300, 400, 0.12, 0.2 * a);
    else if (kind === 'overcharge') { this.tone('sawtooth', 300, 1200, 0.35, 0.3 * a); this.tone('sine', 120, 60, 0.4, 0.3 * a); }
    else if (kind === 'hover') this.tone('sine', 400, 1600, 0.25, 0.2 * a);
    else if (kind === 'grenade') this.tone('triangle', 300, 500, 0.15, 0.15 * a);
  }
  impact(d: number) { this.noise(0.08, 0.15 * Sfx.att(d), 2500); }
  stick(d: number) { this.tone('sine', 1800, 1700, 0.15, 0.2 * Sfx.att(d)); }
  explode(d: number) { this.noise(0.9, 0.9 * Sfx.att(d), 600); this.tone('sine', 90, 30, 0.8, 0.6 * Sfx.att(d)); }
  hit() { this.tone('square', 2000, 1800, 0.04, 0.08); }
  hurt() { this.tone('sawtooth', 200, 90, 0.15, 0.2); }
  shieldDown() { this.tone('sawtooth', 600, 150, 0.4, 0.2); }
  overheat() { this.noise(0.6, 0.25, 4000); this.tone('sine', 700, 200, 0.6, 0.15); }
  jump() { this.tone('sine', 220, 330, 0.08, 0.05); }
  thud(d: number) { this.tone('sine', 120, 60, 0.12, 0.2 * Sfx.att(d)); }
}
