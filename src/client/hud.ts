import { DT, WEAPON_NAMES, omegaOf, type Player, type SimEvent, type SimState } from '../sim';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private hitUntil = 0;

  update(state: SimState, me: Player | undefined, opts: { yaw: number; timeScale: number; paused: boolean; freefly: boolean }) {
    const cfg = state.config;
    const w = omegaOf(cfg);
    $('ringinfo').innerHTML =
      `R ${cfg.R.toFixed(0)} m · g ${cfg.g.toFixed(2)}<br/>` +
      `ω ${w.toFixed(4)} rad/s · period ${((2 * Math.PI) / w).toFixed(1)} s<br/>` +
      `rim speed ${(w * cfg.R).toFixed(1)} m/s<br/>` +
      (!cfg.coriolis || !cfg.centrifugal ? `<span style="color:#ff6a3d">${!cfg.centrifugal ? 'CENTRIFUGAL OFF ' : ''}${!cfg.coriolis ? 'CORIOLIS OFF' : ''}</span><br/>` : '') +
      (opts.timeScale !== 1 ? `<span style="color:#ffd27a">time ×${opts.timeScale.toFixed(2)}</span><br/>` : '') +
      (opts.paused ? '<span style="color:#ffd27a">PAUSED</span><br/>' : '') +
      (opts.freefly ? '<span style="color:#ffd27a">FREE-FLY CAMERA (V)</span><br/>' : '') +
      `t ${(state.tick * DT).toFixed(1)} s`;
    // Spinward is yaw = 0 in the local frame; show it relative to where we face.
    $('spin-arrow').style.transform = `rotate(${-opts.yaw}rad)`;
    if (!me) return;
    $('shield-fill').style.width = `${(100 * me.shield) / cfg.maxShield}%`;
    $('health-fill').style.width = `${(100 * Math.max(0, me.health)) / cfg.maxHealth}%`;
    ($('shield-fill').parentElement as HTMLElement).style.borderColor = me.shield <= 0 ? '#ff6a3d' : '';
    $('weight').textContent = me.apparentG.toFixed(2);
    $('speed').textContent = Math.hypot(...me.vel).toFixed(1);
    $('weapon-name').textContent = WEAPON_NAMES[me.weapon] + (me.weapon === 0 && state.tick < me.rifleOverheatUntil ? ' — OVERHEATED' : '');
    const heat = me.weapon === 0 ? me.rifleHeat : me.weapon === 1 ? me.pistolHeat : 0;
    $('heat-fill').style.width = `${heat * 100}%`;
    const pips = (n: number) => '◆'.repeat(n) + '◇'.repeat(Math.max(0, 4 - n));
    $('grenades').innerHTML = `<span class="sticky">G ${pips(me.grenades)}</span>  <span class="bounce">F ${pips(me.bounceGrenades)}</span>`;
    const ch = $('charge');
    ch.style.opacity = me.pistolCharge > 0 ? '1' : '0';
    (ch.firstElementChild as HTMLElement).style.width = `${me.pistolCharge * 100}%`;
    const dead = $('dead');
    if (!me.alive) {
      const killer = state.players.find((p) => p.id === me.lastAttacker);
      dead.classList.remove('hidden');
      dead.textContent = `${killer && killer.id !== me.id ? `Killed by ${killer.name}` : 'You played yourself'} — respawning in ${Math.max(0, (me.respawnTick - state.tick) * DT).toFixed(1)} s`;
    } else dead.classList.add('hidden');
    const now = performance.now();
    $('hitmark').style.opacity = now < this.hitUntil ? '1' : '0';
    this.feed = this.feed.filter((f) => f.until > now);
    $('feed').innerHTML = this.feed.map((f) => f.text).join('<br/>');
  }

  onEvent(state: SimState, e: SimEvent, localId: number) {
    const name = (id: number) => state.players.find((p) => p.id === id)?.name ?? '?';
    if (e.type === 'hit' && e.attacker === localId && e.target !== localId) this.hitUntil = performance.now() + 150;
    if (e.type === 'kill') {
      const how = e.cause === 'spaced' ? 'knocked off the ring' : e.cause === 'grenade' ? 'grenade' : e.cause;
      const text = e.killer === e.victim
        ? `${name(e.victim)} <i>${e.cause === 'spaced' ? 'fell off the ring' : 'outplayed themselves (' + how + ')'}</i>`
        : `${name(e.killer)} <i>[${how}]</i> ${name(e.victim)}`;
      this.push(text);
    }
    if (e.type === 'stick' && e.target === localId) this.push('<span style="color:#ff6a3d">YOU ARE STUCK</span>');
  }

  push(text: string) {
    this.feed.push({ text, until: performance.now() + 5000 });
    if (this.feed.length > 6) this.feed.shift();
  }
}
