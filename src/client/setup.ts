// Who's playing: your name and colour (title screen), and the match setup
// for deathmatch (free-for-all or teams, bots on each team, team bases).
// Both are remembered in this browser.

import { ITEM_KINDS, LOADOUT_WEAPONS, TEAM_COLORS, TEAM_NAMES, WEAPON_IDS, WEAPON_NAMES, maxTeamBases, splitBots, type GameSetup, type ItemKind, type LevelDef, type SimConfig, type WeaponId } from '../sim';
import { ITEM_NAMES } from './models';

export interface PlayerPrefs { name: string; color: number } // color -1 = default blue
export interface ItemPrefs { banned: ItemKind[]; start: WeaponId[]; sticky: number; bounce: number; jetpack: boolean; grapple: boolean }
export const ITEM_DEFAULTS: ItemPrefs = { banned: [], start: ['rifle', 'pistol'], sticky: 4, bounce: 4, jetpack: false, grapple: true };
export interface MatchPrefs { teams: number; myTeam: number; bots: (number | null)[]; bases: boolean; ctf: boolean; spin: boolean; spinLimit: number; scoreLimit: number; ctfLimit: number; timeLimit: number; items: ItemPrefs; showItems: boolean } // limits: 0 = none; timeLimit in minutes // bots: null = the level's own number

export const PLAYER_COLORS = [-1, 0x2fb8c8, 0xe07a2a, 0xd84aa0, 0x8a5ad8, 0xe8e6dc, 0x40c080, 0xc8a040];

const load = <T,>(key: string, fallback: T): T => {
  try { const s = localStorage.getItem(key); return s ? { ...fallback, ...JSON.parse(s) } : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not remembered: fine for now */ } };

export const player: PlayerPrefs = load('cr-player', { name: '', color: -1 });
export const match: MatchPrefs = load('cr-match', { teams: 0, myTeam: 0, bots: [null, null, null, null], bases: true, ctf: false, spin: false, spinLimit: 100, scoreLimit: 15, ctfLimit: 3, timeLimit: 0, items: { ...ITEM_DEFAULTS }, showItems: false });
match.items = { ...ITEM_DEFAULTS, ...match.items }; // (older saved settings had none)

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Name and colour, on the title screen. */
export function buildPlayerPanel(el: HTMLElement) {
  el.innerHTML = '';
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 16;
  name.placeholder = 'Your name';
  name.value = player.name;
  name.addEventListener('input', () => { player.name = name.value; save('cr-player', player); });
  const label = document.createElement('label');
  label.textContent = 'Name ';
  label.appendChild(name);
  el.appendChild(label);
  const sw = document.createElement('span');
  sw.className = 'swatches';
  sw.textContent = 'Colour ';
  for (const c of PLAYER_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === player.color ? ' on' : '');
    b.style.background = hex(c < 0 ? 0x3d7bd9 : c);
    b.title = c < 0 ? 'Default' : hex(c);
    b.addEventListener('click', () => {
      player.color = c;
      save('cr-player', player);
      for (const x of sw.querySelectorAll('.swatch')) x.classList.remove('on');
      b.classList.add('on');
    });
    sw.appendChild(b);
  }
  el.appendChild(sw);
  const note = document.createElement('div');
  note.className = 'small-note';
  note.textContent = 'In team games your team colour replaces your own.';
  el.appendChild(note);
}

/** The match setup above the deathmatch levels. `onChange` re-lists the levels (whether each has room for bases). */
export function buildMatchPanel(el: HTMLElement, onChange: () => void) {
  el.innerHTML = '';
  const row = (text: string, control: HTMLElement) => {
    const l = document.createElement('label');
    l.textContent = text + ' ';
    l.appendChild(control);
    el.appendChild(l);
    return l;
  };
  const select = (opts: [string, string][], value: string, set: (v: string) => void) => {
    const s = document.createElement('select');
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); }
    s.value = value;
    s.addEventListener('change', () => { set(s.value); save('cr-match', match); buildMatchPanel(el, onChange); onChange(); });
    return s;
  };
  const modeVal = match.teams >= 2 && match.spin ? 'spin2' : match.teams >= 2 && match.ctf ? `ctf${match.teams}` : String(match.teams);
  row('Mode', select([['0', 'Free-for-all'], ['2', '2 teams'], ['3', '3 teams'], ['4', '4 teams'], ['ctf2', 'Capture the flag (2 teams)'], ['ctf3', 'Capture the flag (3 teams)'], ['ctf4', 'Capture the flag (4 teams)'], ['spin2', 'Spin control (2 teams)']], modeVal, (v) => {
    match.ctf = v.startsWith('ctf');
    match.spin = v.startsWith('spin');
    match.teams = +v.replace('ctf', '').replace('spin', '');
    match.myTeam = Math.min(match.myTeam, Math.max(0, match.teams - 1));
  }));
  const n = Math.max(1, match.teams);
  if (match.teams >= 2) {
    row('Your team', select(TEAM_NAMES.slice(0, n).map((t, i) => [String(i), t]), String(match.myTeam), (v) => { match.myTeam = +v; }));
  }
  const bots = document.createElement('span');
  bots.className = 'bots';
  bots.textContent = match.teams >= 2 ? 'Bots ' : '';
  for (let t = 0; t < n; t++) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0';
    inp.max = '30';
    inp.placeholder = 'auto';
    inp.value = match.bots[t] === null || match.bots[t] === undefined ? '' : String(match.bots[t]);
    inp.title = match.teams >= 2 ? `Bots on ${TEAM_NAMES[t]} (blank: share out the level's bots)` : "Bots (blank: the level's own number)";
    if (match.teams >= 2) inp.style.borderColor = hex(TEAM_COLORS[t]);
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      match.bots[t] = v === '' ? null : Math.max(0, Math.min(30, Math.round(+v) || 0));
      save('cr-match', match);
    });
    bots.appendChild(inp);
  }
  if (match.teams >= 2) el.appendChild(bots); else row('Bots', bots);
  // what ends the match: a score, a time, both or neither (scores are kept either way)
  const ctfMode = match.teams >= 2 && match.ctf && !match.spin, spinMode = match.teams >= 2 && match.spin;
  const lim = ctfMode ? [1, 2, 3, 5, 7, 10] : spinMode ? [30, 60, 100, 150, 200, 300] : [5, 10, 15, 25, 50, 100];
  const cur = ctfMode ? match.ctfLimit : spinMode ? match.spinLimit : match.scoreLimit;
  row(ctfMode ? 'Captures to win' : spinMode ? 'Points to win' : 'Score to win', select([['0', 'No limit'], ...lim.map((n) => [String(n), String(n)] as [string, string])], String(cur), (v) => { if (ctfMode) match.ctfLimit = +v; else if (spinMode) match.spinLimit = +v; else match.scoreLimit = +v; }))
    .title = ctfMode ? 'First team to this many captures wins' : spinMode ? 'A point for every second your team has the engine room to itself' : 'A kill scores 1, killing yourself loses 1; first to this wins (a team: its total)';
  row('Time', select([['0', 'No limit'], ...[2, 5, 10, 15, 20, 30].map((n) => [String(n), `${n} min`] as [string, string])], String(match.timeLimit), (v) => { match.timeLimit = +v; }))
    .title = 'When time runs out the highest score wins';
  // pickups and loadout, folded away unless you want them
  const changed = itemsChanged();
  const tog = document.createElement('button');
  tog.className = 'mini';
  tog.textContent = `Items${changed ? ' (changed)' : ''} ${match.showItems ? '▾' : '▸'}`;
  tog.addEventListener('click', () => { match.showItems = !match.showItems; save('cr-match', match); buildMatchPanel(el, onChange); });
  if (match.teams >= 2 && !match.ctf && !match.spin) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = match.bases;
    cb.addEventListener('change', () => { match.bases = cb.checked; save('cr-match', match); onChange(); });
    row('Team bases', cb).title = 'Each team spawns at its own base, with the pickups the same on every side (where the level has room)';
  }
  el.appendChild(tog);
  if (match.showItems) el.appendChild(itemsPanel(() => { save('cr-match', match); buildMatchPanel(el, onChange); }));
}

function itemsChanged(): boolean {
  const it = match.items, d = ITEM_DEFAULTS;
  return it.banned.length > 0 || it.start.join() !== d.start.join() || it.sticky !== d.sticky || it.bounce !== d.bounce || it.jetpack !== d.jetpack || it.grapple !== d.grapple;
}

/** Checkboxes: what pickups are on the field, and what everyone starts with. */
function itemsPanel(changed: () => void): HTMLElement {
  const it = match.items;
  const box = document.createElement('div');
  box.className = 'items-panel';
  const check = (label: string, on: boolean, set: (v: boolean) => void, title = '') => {
    const l = document.createElement('label');
    l.className = 'chk';
    if (title) l.title = title;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = on;
    c.addEventListener('change', () => { set(c.checked); changed(); });
    l.append(c, ' ' + label);
    return l;
  };
  const section = (title: string, note: string) => {
    const s = document.createElement('div');
    s.className = 'items-section';
    const h = document.createElement('div');
    h.className = 'items-title';
    h.innerHTML = `${title} <span>${note}</span>`;
    s.appendChild(h);
    box.appendChild(s);
    return s;
  };
  const field = section('On the field', '(unticked: never appears; its spots get something else)');
  for (const k of ITEM_KINDS) {
    field.appendChild(check(ITEM_NAMES[k], !it.banned.includes(k), (v) => { it.banned = v ? it.banned.filter((x) => x !== k) : [...it.banned, k]; }));
  }
  const start = section('Everyone starts with', '(and gets again on every respawn)');
  for (const w of LOADOUT_WEAPONS) {
    start.appendChild(check(WEAPON_NAMES[WEAPON_IDS.indexOf(w)], it.start.includes(w), (v) => {
      const next = v ? [...it.start, w] : it.start.filter((x) => x !== w);
      it.start = next.length ? LOADOUT_WEAPONS.filter((x) => next.includes(x)) : it.start; // (at least one weapon)
    }));
  }
  const count = (label: string, value: number, set: (n: number) => void) => {
    const l = document.createElement('label');
    l.className = 'chk';
    const s = document.createElement('select');
    for (let n = 0; n <= 4; n++) { const o = document.createElement('option'); o.value = String(n); o.textContent = String(n); s.appendChild(o); }
    s.value = String(value);
    s.addEventListener('change', () => { set(+s.value); changed(); });
    l.append(s, ' ' + label);
    return l;
  };
  start.appendChild(count('sticky grenades', it.sticky, (n) => { it.sticky = n; }));
  start.appendChild(count('bouncing grenades', it.bounce, (n) => { it.bounce = n; }));
  start.appendChild(check('Jetpack', it.jetpack, (v) => { it.jetpack = v; }));
  start.appendChild(check('Grappling hook', it.grapple, (v) => { it.grapple = v; }));
  const reset = document.createElement('button');
  reset.className = 'mini';
  reset.textContent = 'Back to the usual';
  reset.addEventListener('click', () => { match.items = { ...ITEM_DEFAULTS }; changed(); });
  box.appendChild(reset);
  return box;
}

/** Does this level give each team a base, with the current setup? */
export function basesFor(def: LevelDef, defaults: SimConfig): boolean {
  return match.teams >= 2 && (match.bases || match.ctf || match.spin) && maxTeamBases({ ...defaults, ...def.config } as SimConfig) >= match.teams;
}

/** The setup to start `def` with. */
export function setupFor(def: LevelDef): GameSetup {
  const s: GameSetup = { name: player.name, color: player.color };
  if (def.mode !== 'sandbox') return s;
  s.scoreLimit = match.teams >= 2 && match.spin ? match.spinLimit : match.teams >= 2 && match.ctf ? match.ctfLimit : match.scoreLimit;
  const it = match.items;
  Object.assign(s, { bannedItems: [...it.banned], startWeapons: [...it.start], startSticky: it.sticky, startBounce: it.bounce, startJetpack: it.jetpack, startGrapple: it.grapple });
  s.timeLimit = match.timeLimit * 60;
  const teams = match.teams >= 2 ? match.teams : 0;
  if (teams) {
    const auto = splitBots(def.bots ?? 0, teams, match.myTeam);
    return { ...s, teams, myTeam: match.myTeam, bases: match.bases || match.ctf || match.spin, ctf: match.ctf && !match.spin, spinControl: match.spin && teams === 2, bots: auto.map((a, t) => match.bots[t] ?? a) };
  }
  return { ...s, ...(match.bots[0] !== null && match.bots[0] !== undefined ? { bots: [match.bots[0]] } : {}) };
}
