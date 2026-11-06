import { DT, PLAYER_WEAPON_SLOTS, slotKey, WEAPON_IDS, WEAPON_NAMES, omegaOf, spinAt, type Player, type SimEvent, type SimState } from '../sim';
import { ITEM_NAMES } from './models';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private hitUntil = 0;

  update(state: SimState, me: Player | undefined, opts: { yaw: number; timeScale: number; paused: boolean; freefly: boolean; sprintOn: boolean; showScores: boolean }) {
    const cfg = state.config;
    const sp = spinAt(cfg, state.tick);
    const w = sp.omega;
    const w0 = omegaOf(cfg);
    // a changing spin: how much is left, which way it's going, and the Euler push along the floor
    const change = cfg.spin && cfg.spinChange
      ? `<span style="color:${sp.alpha ? '#ff6a3d' : '#ffd27a'}">spin ${(100 * w / w0).toFixed(0)}%${w < 0 ? ' (REVERSED)' : ''}` +
        (sp.alpha ? ` · SPINNING ${sp.alpha < 0 ? 'DOWN' : 'UP'} · Euler ${(Math.abs(sp.alpha) * cfg.R).toFixed(1)} m/s² ${sp.alpha < 0 ? 'spinward' : 'antispinward'}` : '') +
        '</span><br/>'
      : '';
    const planet = cfg.world === 'planet'
      ? `Planet R ${cfg.R.toFixed(0)} m · surface g ${cfg.g.toFixed(2)}<br/>` +
        `spin period ${((2 * Math.PI) / w).toFixed(1)} s · equator weighs ${(100 * (1 - (w * w * cfg.R) / cfg.g)).toFixed(0)}%<br/>` +
        (cfg.outerShell > 0
          ? `shell r ${cfg.outerShell.toFixed(0)} m · weightless at r ${Math.cbrt((cfg.g * cfg.R * cfg.R) / (w * w)).toFixed(0)} m · shell equator ${(100 * (w * w * cfg.outerShell - (cfg.g * cfg.R * cfg.R) / cfg.outerShell ** 2) / cfg.g).toFixed(0)}%<br/>`
          : `orbit ${Math.sqrt(cfg.g * cfg.R).toFixed(1)} m/s · escape ${Math.sqrt(2 * cfg.g * cfg.R).toFixed(1)} m/s (ground moves east at ${(w * cfg.R).toFixed(1)})<br/>`)
      : '';
    const twin = cfg.twin && me
      ? `<span style="color:${me.pos[2] >= 0 ? '#ff9a3a' : '#3ac8ff'}">TWIN RINGS · you're on ring ${me.pos[2] >= 0 ? 'B (orange)' : 'A (blue)'}; the other one's floor passes at ${(2 * w * cfg.R).toFixed(0)} m/s</span><br/>`
      : '';
    const disk = cfg.world === 'disk'
      ? `Disk R ${cfg.R.toFixed(0)} m · g ${cfg.g.toFixed(2)} down · spin period ${((2 * Math.PI) / Math.max(1e-6, Math.abs(w))).toFixed(1)} s<br/>` +
        (cfg.diskBowl ? `curved: gravity always straight into the ground (${Math.sqrt(1 + cfg.planetSpin ** 2).toFixed(2)} g at the rim)<br/>`
          : `too steep to stand beyond ${Math.min(cfg.R, ((4 / 3) * cfg.R) / cfg.planetSpin).toFixed(0)} m from the middle<br/>`)
      : '';
    $('ringinfo').innerHTML = planet ? planet + change : disk ? disk + change : twin +
      (cfg.spin
        ? `R ${cfg.R.toFixed(0)} m · g ${cfg.g.toFixed(2)}<br/>` +
          `ω ${w.toFixed(4)} rad/s · period ${Math.abs(w) > 1e-6 ? ((2 * Math.PI) / Math.abs(w)).toFixed(1) + ' s' : '∞'}<br/>` +
          `rim speed ${(w * cfg.R).toFixed(1)} m/s<br/>` + change
        : `Earth · g ${cfg.gravity.toFixed(2)} · no spin<br/>`) +
      (cfg.dragType !== 'none' && cfg.dragCoeff > 0 ? `atmosphere: ${cfg.dragType} drag ${cfg.dragCoeff}<br/>` : '') +
      (cfg.spin && cfg.gravity ? `+ real gravity ${cfg.gravity.toFixed(2)} m/s²<br/>` : '') +
      (cfg.planetPull ? `planet pull ${cfg.planetPull.toFixed(1)} m/s² (sweeps round each spin)<br/>` : '') +
      (!cfg.coriolis || !cfg.centrifugal ? `<span style="color:#ff6a3d">${!cfg.centrifugal ? 'CENTRIFUGAL OFF ' : ''}${!cfg.coriolis ? 'CORIOLIS OFF' : ''}</span><br/>` : '') +
      (opts.timeScale !== 1 ? `<span style="color:#ffd27a">time ×${opts.timeScale.toFixed(2)}</span><br/>` : '') +
      (opts.freefly ? '<span style="color:#ffd27a">FREE-FLY CAMERA</span><br/>' : '');
    // Spinward is yaw = 0 in the local frame; show it relative to where we face.
    $('spin-arrow').style.transform = `rotate(${-opts.yaw}rad)`;
    $('compass').style.display = cfg.spin ? '' : 'none';
    if (!me) return;
    $('shield-fill').style.width = `${(100 * me.shield) / Math.max(1, me.maxShield)}%`;
    $('health-fill').style.width = `${(100 * Math.max(0, me.health)) / me.maxHealth}%`;
    // Tab: scoreboard
    const sc = $('scores');
    sc.classList.toggle('hidden', !opts.showScores);
    if (opts.showScores) {
      const rows = state.players.filter((p) => p.kind !== 'dummy').sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      sc.textContent = 'NAME              KILLS  DEATHS\n' + rows.map((p) => `${(p.id === me.id ? '> ' : '  ') + p.name.padEnd(16)}${String(p.kills).padStart(5)}  ${String(p.deaths).padStart(6)}`).join('\n');
    }
    // hover-bike: health and a prompt when one is in reach
    const bike = state.vehicles.find((v) => v.id === me.vehicle);
    const near = !bike && me.alive && state.vehicles.some((v) => v.alive && v.driver < 0 && Math.hypot(v.pos[0] - me.pos[0], v.pos[1] - me.pos[1], v.pos[2] - me.pos[2]) < 2.6);
    $('vehicle').innerHTML = bike
      ? `HOVER-BIKE ${Math.ceil(bike.health)} / ${bike.maxHealth} · ${Math.hypot(...bike.vel).toFixed(0)} m/s · <b>E</b> get off`
      : near ? '<b>E</b> ride hover-bike' : '';
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
    const reloading = me.reloadUntil > state.tick && me.reloadWeapon === me.weapon;
    $('weapon-name').textContent = WEAPON_NAMES[wi] + (overheated ? ' — OVERHEATED' : reloading ? ' — RELOADING' : '');
    // ammo weapons show rounds; heat weapons show the heat bar
    const heatBar = $('heat-fill').parentElement as HTMLElement;
    heatBar.style.display = st.magSize > 0 ? 'none' : '';
    $('heat-fill').style.width = `${me.heat[wi] * 100}%`;
    $('ammo').textContent = st.magSize > 0 ? `${me.mag[wi]} | ${me.infiniteAmmo ? '∞' : me.ammo[wi]}` : '';
    $('weapons').innerHTML = WEAPON_IDS.slice(0, PLAYER_WEAPON_SLOTS)
      .map((_, i) => (me.owned.includes(i) ? `<span class="${i === wi ? 'cur' : ''}">${slotKey(i)}</span>` : `<span class="no">${slotKey(i)}</span>`))
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
