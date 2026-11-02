// Samples keyboard/mouse into per-tick InputCmds. The local player is driven
// exclusively through these commands, exactly like bots and (later) remote
// clients.

import { BTN_AIM, BTN_FIRE, BTN_GRENADE, BTN_JUMP, BTN_SPRINT, type InputCmd } from '../sim';

export class InputSampler {
  keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  weapon = 0;
  sensitivity = 0.0022;
  mouseButtons = 0;
  private latched = 0; // presses shorter than a tick still register
  enabled = true; // false while free-flying: player gets neutral movement
  onKey: (code: string) => void = () => {};
  freeLook: ((dx: number, dy: number) => void) | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.latched |= BTN_JUMP;
      if (e.code === 'KeyG') this.latched |= BTN_GRENADE;
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        if (n >= 0 && n <= 2) this.weapon = n;
      }
      this.onKey(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseButtons = 0; });
    el.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      if (e.button === 0) this.latched |= BTN_FIRE;
    });
    window.addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.el) return;
      if (this.freeLook) return this.freeLook(e.movementX, e.movementY);
      this.yaw += e.movementX * this.sensitivity;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * this.sensitivity));
    });
    el.addEventListener('wheel', (e) => { this.weapon = this.weapon === 0 ? 1 : 0; });
  }

  get aiming() { return (this.mouseButtons & 4) !== 0; }
  get grenadeHeld() { return this.keys.has('KeyG'); }

  sample(playerId: number, tick: number): InputCmd {
    const k = this.keys;
    let buttons = this.latched;
    this.latched = 0;
    if (!this.enabled) return { playerId, tick, moveX: 0, moveY: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0, weapon: this.weapon };
    if (this.mouseButtons & 1) buttons |= BTN_FIRE;
    if (this.mouseButtons & 4) buttons |= BTN_AIM;
    if (k.has('Space')) buttons |= BTN_JUMP;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) buttons |= BTN_SPRINT;
    if (k.has('KeyG')) buttons |= BTN_GRENADE;
    const moveY = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    return { playerId, tick, moveX, moveY, yaw: this.yaw, pitch: this.pitch, buttons, weapon: this.weapon };
  }
}
