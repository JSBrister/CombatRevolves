// Samples keyboard/mouse into per-tick InputCmds. The local player is driven
// exclusively through these commands, exactly like bots and (later) remote
// clients.

import { BTN_AIM, BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_MELEE, BTN_RELOAD, BTN_SPRINT, BTN_USE, PLAYER_WEAPON_SLOTS, type InputCmd } from '../sim';

export class InputSampler {
  keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  weapon = 0;
  sensitivity = 0.0022;
  /** Multiplies mouse look (the pulse laser slows your aim while charging). */
  lookScale = 1;
  /** Sprint is a toggle (Shift), on by default. */
  sprintOn = true;
  /** Weapons the local player owns (kept up to date by the game loop) for the scroll wheel. */
  owned: number[] = [0, 1];
  mouseButtons = 0;
  private latched = 0; // presses shorter than a tick still register
  enabled = true; // false while free-flying: player gets neutral movement
  onKey: (code: string) => void = () => {};
  freeLook: ((dx: number, dy: number) => void) | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return; // typing in a form
      this.keys.add(e.code);
      if (e.code === 'Space') this.latched |= BTN_JUMP;
      if (e.code === 'KeyG') this.latched |= BTN_GRENADE;
      if (e.code === 'KeyF') this.latched |= BTN_GRENADE2;
      if (e.code === 'KeyR') this.latched |= BTN_RELOAD;
      if (e.code === 'KeyQ') this.latched |= BTN_MELEE;
      if (e.code === 'KeyE') this.latched |= BTN_USE;
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && this.enabled) this.sprintOn = !this.sprintOn;
      if (e.code.startsWith('Digit') || e.code === 'Minus' || e.code === 'Equal') {
        // 1-9, then 0, - and = for slots 10-12
        const n = e.code === 'Minus' ? 10 : e.code === 'Equal' ? 11 : Number(e.code.slice(5)) === 0 ? 9 : Number(e.code.slice(5)) - 1;
        if (n >= 0 && n < PLAYER_WEAPON_SLOTS) this.weapon = n; // the hover gun is debug-panel only
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
      const k = this.sensitivity * this.lookScale;
      this.yaw += e.movementX * k;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * k));
    });
    el.addEventListener('wheel', (e) => this.cycleWeapon(e.deltaY > 0 ? 1 : -1), { passive: true });
  }

  /** Step through the weapons we own. */
  cycleWeapon(dir: number) {
    const list = this.owned.filter((w) => w < PLAYER_WEAPON_SLOTS);
    if (!list.length) return;
    const i = list.indexOf(this.weapon);
    this.weapon = list[(i < 0 ? 0 : i + dir + list.length) % list.length];
  }

  get aiming() { return (this.mouseButtons & 4) !== 0; }
  get grenadeHeld() { return this.keys.has('KeyG'); }
  get bounceHeld() { return this.keys.has('KeyF'); }

  sample(playerId: number, tick: number): InputCmd {
    const k = this.keys;
    let buttons = this.latched;
    this.latched = 0;
    if (!this.enabled) return { playerId, tick, moveX: 0, moveY: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0, weapon: this.weapon };
    if (this.mouseButtons & 1) buttons |= BTN_FIRE;
    if (this.mouseButtons & 4) buttons |= BTN_AIM;
    if (k.has('Space')) buttons |= BTN_JUMP;
    if (this.sprintOn) buttons |= BTN_SPRINT;
    if (k.has('KeyG')) buttons |= BTN_GRENADE;
    if (k.has('KeyF')) buttons |= BTN_GRENADE2;
    if (k.has('KeyR')) buttons |= BTN_RELOAD;
    if (k.has('KeyQ')) buttons |= BTN_MELEE;
    if (k.has('KeyE')) buttons |= BTN_USE;
    const moveY = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    return { playerId, tick, moveX, moveY, yaw: this.yaw, pitch: this.pitch, buttons, weapon: this.weapon };
  }
}
