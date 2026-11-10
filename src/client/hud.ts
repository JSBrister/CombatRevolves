import { DT, matchScores, timeLeft, TEAM_COLORS, TEAM_NAMES, PLAYER_WEAPON_SLOTS, slotKey, WEAPON_IDS, WEAPON_NAMES, omegaOf, spinNow, type Player, type SimEvent, type SimState } from '../sim';
import { ITEM_NAMES } from './models';

const $ = (id: string) => document.getElementById(id)!;
/** Names are typed by players: keep them as text. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** A player's name, in their colour (team colour in team games). */
const tag = (p: Player | undefined) => (!p ? '?' : p.color >= 0 ? `<span style="color:${hex(p.color)}">${esc(p.name)}</span>` : esc(p.name));

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private hitUntil = 0;

  update(state: SimState, me: Player | undefined, opts: { yaw: number; timeScale: number; paused: boolean; freefly: boolean; sprintOn: boolean; showScores: boolean }) {
    const cfg = state.config;
    const sp = spinNow(state);
    const w = sp.omega;
    const w0 = omegaOf(cfg);
    // a changing spin: how much is left, which way it's going, and the Euler push along the floor
    const change = cfg.spin && (cfg.spinChange || cfg.spinControl)
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
    const tower = cfg.tower > 0
      ? `Spin tower · ${(cfg.g / 9.81).toFixed(2)} Earth g at the ends, weightless at the axis · period ${((2 * Math.PI) / Math.max(1e-6, Math.abs(w))).toFixed(1)} s<br/>` +
        (me ? `the spin pulls ${((w * w * Math.hypot(me.pos[0], me.pos[1])) / 9.81).toFixed(2)} Earth g here<br/>` : '')
      : '';
    $('ringinfo').innerHTML = planet ? planet + change : tower ? tower + change : disk ? disk + change : twin +
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
      const rows = state.players.filter((p) => p.kind !== 'dummy').sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
      const line = (p: Player) => `${p.id === me.id ? '&gt; ' : '  '}<span style="color:${p.color >= 0 ? hex(p.color) : 'inherit'}">${esc(p.name.padEnd(16))}</span>${String(p.score).padStart(5)}  ${String(p.kills).padStart(5)}  ${String(p.deaths).padStart(6)}`;
      if (cfg.teams >= 2) {
        // by team, best team first (by captures, in capture the flag)
        const ts = matchScores(state);
        const score = (t: number) => (ts.find((x) => x.id === t)?.score ?? 0) * 1000 + teamKills(state, t);
        const teams = Array.from({ length: cfg.teams }, (_, t) => t).sort((a, b) => score(b) - score(a));
        sc.innerHTML = 'NAME              SCORE  KILLS  DEATHS\n' + teams.map((t) => `<span style="color:${hex(TEAM_COLORS[t])}">${(TEAM_NAMES[t].toUpperCase() + (state.flags.length ? `  ⚑ ${state.captures[t] ?? 0}` : '')).padEnd(18)}${String(ts.find((x) => x.id === t)?.score ?? 0).padStart(5)}  ${String(teamKills(state, t)).padStart(5)}</span>\n` +
          rows.filter((p) => p.team === t).map(line).join('\n')).join('\n\n');
      } else sc.innerHTML = 'NAME              SCORE  KILLS  DEATHS\n' + rows.map(line).join('\n');
    }
    const ctf = state.flags.length > 0;
    // the score line: teams, or in a free-for-all you and whoever's ahead; then what ends the match
    const ms = matchScores(state);
    const tl = timeLeft(state);
    const limits = [
      cfg.scoreLimit > 0 ? `first to ${cfg.scoreLimit}${ctf ? ' captures' : ''}` : '',
      tl < Infinity ? `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, '0')} left` : '',
    ].filter(Boolean).join(' · ');
    let scoreLine = '';
    if (state.mode === 'sandbox' && cfg.teams >= 2) {
      scoreLine = ms.map((x) => `<span style="color:${hex(TEAM_COLORS[x.id])}">${TEAM_NAMES[x.id].toUpperCase()} ${ctf ? '⚑ ' : ''}${x.score}</span>`).join('');
    } else if (state.mode === 'sandbox' && ms.length > 1) {
      const lead = [...ms].filter((x) => x.id !== me.id).sort((a, b) => b.score - a.score)[0];
      const lp = state.players.find((p) => p.id === lead.id);
      scoreLine = `<span>You ${me.score}</span><span>${me.score >= lead.score ? 'next' : 'leader'}: ${tag(lp)} ${lead.score}</span>`;
    }
    $('team-scores').innerHTML = scoreLine + (scoreLine && limits ? `<div class="small"${tl < 30 ? ' style="color:#ff6a3d;opacity:1"' : ''}>${limits}</div>` : '');
    if (ctf) {
      // the flags: where each one is, and (if you've got one) what to do
      const where = (f: (typeof state.flags)[number]) => {
        if (f.state === 'home') return 'at home';
        if (f.state === 'dropped') return `dropped · home in ${Math.max(0, cfg.flagReturnTime - (state.tick - f.droppedTick) * DT).toFixed(0)} s`;
        const c = state.players.find((q) => q.id === f.carrier);
        return `TAKEN by ${tag(c)}`;
      };
      const lines = state.flags.map((f) => `<span style="color:${hex(TEAM_COLORS[f.team])}">${f.team === me.team ? 'Your flag' : `${TEAM_NAMES[f.team]} flag`}</span>: ${where(f)}`);
      const carrying = me.carrying >= 0
        ? `<div class="carry" style="color:${hex(TEAM_COLORS[me.carrying])}">YOU HAVE THE ${TEAM_NAMES[me.carrying].toUpperCase()} FLAG · ${
          state.flags.find((f) => f.team === me.team)?.state === 'home' ? 'take it home to your own flag' : "your own flag is away: you can't score until it's back"} · Q tosses it</div>`
        : '';
      $('objective').innerHTML = carrying + lines.join(' &nbsp;·&nbsp; ');
    }
    if (state.objective) {
      // spin control: who holds the engine room, and whose way the spin's turning
      const ob = state.objective, bases = state.level.bases ?? [];
      const held = ob.holder >= 0 ? `<span style="color:${hex(TEAM_COLORS[ob.holder])}">held by ${TEAM_NAMES[ob.holder]}</span>` : ob.holder === -2 ? '<span style="color:#ff6a3d">CONTESTED</span>' : 'empty';
      let favours = '';
      if (bases.length === 2) {
        const b0 = bases.find((b) => b.team === 0)!;
        const s0 = Math.sign(Math.sin(Math.atan2(ob.pos[1], ob.pos[0]) - Math.atan2(b0.pos[1], b0.pos[0])));
        const f = state.spinF;
        const fav = Math.abs(f) < 0.05 ? -1 : f * s0 > 0 ? 0 : 1;
        const turning = state.spinRate !== 0 ? ` <span style="color:#ff6a3d">· TURNING toward ${TEAM_NAMES[state.spinTarget * s0 > 0 ? 0 : 1]}</span>` : '';
        favours = fav < 0 ? ' · the spin is stopping' : ` · the spin favours <span style="color:${hex(TEAM_COLORS[fav])}">${TEAM_NAMES[fav]}</span>${turning}`;
      }
      $('objective').innerHTML = `ENGINE ROOM: ${held}${favours}`;
    }
    $('objective').classList.toggle('ctf', ctf || !!state.objective);
    // hover-bike: health and a prompt when one is in reach
    const bike = state.vehicles.find((v) => v.id === me.vehicle);
    const near = !bike && me.alive && state.vehicles.some((v) => v.alive && v.driver < 0 && Math.hypot(v.pos[0] - me.pos[0], v.pos[1] - me.pos[1], v.pos[2] - me.pos[2]) < 2.6);
    $('vehicle').innerHTML = bike
      ? `HOVER-BIKE ${Math.ceil(bike.health)} / ${bike.maxHealth} · ${Math.hypot(...bike.vel).toFixed(0)} m/s · <b>E</b> get off`
      : near ? '<b>E</b> ride hover-bike' : '';
    const enemies = state.players.filter((p) => p.enemyType !== '');
    if (!state.flags.length && !state.objective) $('objective').textContent = state.mode === 'campaign' && state.outcome === 'playing'
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
      const by = killer && killer.id !== me.id ? `Killed by ${tag(killer)}` : 'You played yourself';
      dead.innerHTML = me.canRespawn ? `${by} — respawning in ${Math.max(0, (me.respawnTick - state.tick) * DT).toFixed(1)} s` : by;
    } else dead.classList.add('hidden');
    const now = performance.now();
    $('hitmark').style.opacity = now < this.hitUntil ? '1' : '0';
    this.feed = this.feed.filter((f) => f.until > now);
    $('feed').innerHTML = this.feed.map((f) => f.text).join('<br/>');
  }

  onEvent(state: SimState, e: SimEvent, localId: number) {
    const name = (id: number) => tag(state.players.find((p) => p.id === id));
    if (e.type === 'hit' && e.attacker === localId && e.target !== localId) this.hitUntil = performance.now() + 150;
    if (e.type === 'kill') {
      const how = e.cause === 'spaced' ? 'knocked off the ring' : e.cause === 'impact' ? 'splat' : e.cause;
      const text = e.killer === e.victim
        ? `${name(e.victim)} <i>${e.cause === 'spaced' ? 'fell off the ring' : 'outplayed themselves (' + how + ')'}</i>`
        : `${name(e.killer)} <i>[${how}]</i> ${name(e.victim)}`;
      this.push(text);
    }
    if (e.type === 'flag') {
      const flag = `<span style="color:${hex(TEAM_COLORS[e.flagTeam])}">${TEAM_NAMES[e.flagTeam]} flag</span>`;
      const who = e.by >= 0 ? name(e.by) : '';
      this.push(e.what === 'taken' ? `${who} took the ${flag}`
        : e.what === 'dropped' ? `${who} dropped the ${flag}`
        : e.what === 'returned' ? (who ? `${who} returned the ${flag}` : `The ${flag} went home`)
        : `<b>${who} CAPTURED the ${flag}!</b>`);
    }
    if (e.type === 'matchOver') {
      this.push(e.winner < 0 ? '<b>MATCH OVER: A DRAW</b>'
        : state.config.teams >= 2 ? `<b style="color:${hex(TEAM_COLORS[e.winner])}">${TEAM_NAMES[e.winner].toUpperCase()} WINS</b>` : `<b>${name(e.winner)} WINS</b>`);
    }
    if (e.type === 'stick' && e.target === localId) this.push('<span style="color:#ff6a3d">YOU ARE STUCK</span>');
    if (e.type === 'pickup' && e.player === localId) this.push(`<span style="color:#9dff7a">+ ${ITEM_NAMES[e.item]}</span>`);
  }

  push(text: string) {
    this.feed.push({ text, until: performance.now() + 5000 });
    if (this.feed.length > 6) this.feed.shift();
  }
}

/** A team's score: its players' kills. */
function teamKills(state: SimState, team: number) {
  return state.players.reduce((n, p) => n + (p.team === team && p.kind !== 'dummy' ? p.kills : 0), 0);
}
