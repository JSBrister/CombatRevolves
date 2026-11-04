import { DT, WEAPON_IDS, WEAPON_NAMES, omegaOf, type Player, type SimEvent, type SimState } from '../sim';
import { ITEM_NAMES } from './models';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private hitUntil = 0;

  update(state: SimState, me: Player | undefined, opts: { yaw: number; timeScale: number; paused: boolean; freefly: boolean; sprintOn: boolean }) {
    const cfg = state.config;
    const w = omegaOf(cfg);
    $('ringinfo').innerHTML =
      `R ${cfg.R.toFixed(0)} m · g ${cfg.g.toFixed(2)}<br/>` +
      `ω ${w.toFixed(4)} rad/s · period ${((2 * Math.PI) / w).toFixed(1)} s<br/>` +
      `rim speed ${(w * cfg.R).toFixed(1)} m/s<br/>` +
      (!cfg.coriolis || !cfg.centrifugal ? `<span style="color:#ff6a3d">${!cfg.centrifugal ? 'CENTRIFUGAL OFF ' : ''}${!cfg.coriolis ? 'CORIOLIS OFF' : ''}</span><br/>` : '') +
      (opts.timeScale !== 1 ? `<span style="color:#ffd27a">time ×${opts.timeScale.toFixed(2)}</span><br/>` : '') +
      (opts.freefly ? '<span style="color:#ffd27a">FREE-FLY CAMERA</span><br/>' : '');
    // Spinward is yaw = 0 in the local frame; show it relative to where we face.
    $('spin-arrow').style.transform = `rotate(${-opts.yaw}rad)`;
    if (!me) return;
    $('shield-fill').style.width = `${(100 * me.shield) / Math.max(1, me.maxShield)}%`;
    $('health-fill').style.width = `${(100 * Math.max(0, me.health)) / me.maxHealth}%`;
    const enemies = state.players.filter((p) => p.enemyType !== '');
    $('objective').textContent = state.mode === 'campaign' && state.outcome === 'playing'
      ? `Enemies left: ${enemies.filter((p) => p.alive).length} / ${enemies.length}` : '';
    ($('shield-fill').parentElement as HTMLElement).style.borderColor = me.shield <= 0 ? '#ff6a3d' : '';
    $('weight').textContent = me.apparentG.toFixed(2);
    $('speed').textContent = Math.hypot(...me.vel).toFixed(1);
    $('sprint').textContent = opts.sprintOn ? 'sprint on' : 'sprint off (Shift)';
    const wi = me.weapon;
    const st = cfg.weapons[WEAPON_IDS[wi]];
    const overheated = state.tick < me.overheatUntil[wi];
    $('weapon-name').textContent = WEAPON_NAMES[wi] + (overheated ? ' — OVERHEATED' : '');
    // ammo weapons show rounds; heat weapons show the heat bar
    const heatBar = $('heat-fill').parentElement as HTMLElement;
    heatBar.style.display = st.ammoMax > 0 ? 'none' : '';
    $('heat-fill').style.width = `${me.heat[wi] * 100}%`;
    $('ammo').textContent = st.ammoMax > 0 ? `${me.ammo[wi]} / ${st.ammoMax}` : '';
    $('weapons').innerHTML = WEAPON_IDS.slice(0, 5)
      .map((_, i) => (me.owned.includes(i) ? `<span class="${i === wi ? 'cur' : ''}">${i + 1}</span>` : `<span class="no">${i + 1}</span>`))
      .join('');
    const jet = $('jet');
    jet.style.display = me.hasJetpack ? '' : 'none';
    (jet.firstElementChild as HTMLElement).style.width = `${me.jetFuel * 100}%`;
    const pips = (n: number) => '◆'.repeat(n) + '◇'.repeat(Math.max(0, 4 - n));
    $('grenades').innerHTML = `<span class="sticky">G ${pips(me.grenades)}</span>  <span class="bounce">F ${pips(me.bounceGrenades)}</span>`;
    const ch = $('charge');
    ch.style.opacity = me.charge > 0 ? '1' : '0';
    (ch.firstElementChild as HTMLElement).style.width = `${me.charge * 100}%`;
    const dead = $('dead');
    if (!me.alive) {
      const killer = state.players.find((p) => p.id === me.lastAttacker);
      dead.classList.remove('hidden');
      const by = killer && killer.id !== me.id ? `Killed by ${killer.name}` : 'You played yourself';
      dead.textContent = me.canRespawn ? `${by} — respawning in ${Math.max(0, (me.respawnTick - state.tick) * DT).toFixed(1)} s` : by;
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
      const how = e.cause === 'spaced' ? 'knocked off the ring' : e.cause === 'impact' ? 'splat' : e.cause;
      const text = e.killer === e.victim
        ? `${name(e.victim)} <i>${e.cause === 'spaced' ? 'fell off the ring' : 'outplayed themselves (' + how + ')'}</i>`
        : `${name(e.killer)} <i>[${how}]</i> ${name(e.victim)}`;
      this.push(text);
    }
    if (e.type === 'stick' && e.target === localId) this.push('<span style="color:#ff6a3d">YOU ARE STUCK</span>');
    if (e.type === 'pickup' && e.player === localId) this.push(`<span style="color:#9dff7a">+ ${ITEM_NAMES[e.item]}</span>`);
  }

  push(text: string) {
    this.feed.push({ text, until: performance.now() + 5000 });
    if (this.feed.length > 6) this.feed.shift();
  }
}
