// Who's playing: your name and colour (title screen), and the match setup
// for deathmatch (free-for-all or teams, bots on each team, team bases).
// Both are remembered in this browser.

import { TEAM_COLORS, TEAM_NAMES, maxTeamBases, splitBots, type GameSetup, type LevelDef, type SimConfig } from '../sim';

export interface PlayerPrefs { name: string; color: number } // color -1 = default blue
export interface MatchPrefs { teams: number; myTeam: number; bots: (number | null)[]; bases: boolean; ctf: boolean } // bots: null = the level's own number

export const PLAYER_COLORS = [-1, 0x2fb8c8, 0xe07a2a, 0xd84aa0, 0x8a5ad8, 0xe8e6dc, 0x40c080, 0xc8a040];

const load = <T,>(key: string, fallback: T): T => {
  try { const s = localStorage.getItem(key); return s ? { ...fallback, ...JSON.parse(s) } : fallback; } catch { return fallback; }
};
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not remembered: fine for now */ } };

export const player: PlayerPrefs = load('cr-player', { name: '', color: -1 });
export const match: MatchPrefs = load('cr-match', { teams: 0, myTeam: 0, bots: [null, null, null, null], bases: true, ctf: false });

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
  const modeVal = match.teams >= 2 && match.ctf ? `ctf${match.teams}` : String(match.teams);
  row('Mode', select([['0', 'Free-for-all'], ['2', '2 teams'], ['3', '3 teams'], ['4', '4 teams'], ['ctf2', 'Capture the flag (2 teams)'], ['ctf3', 'Capture the flag (3 teams)'], ['ctf4', 'Capture the flag (4 teams)']], modeVal, (v) => {
    match.ctf = v.startsWith('ctf');
    match.teams = +v.replace('ctf', '');
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
  if (match.teams >= 2 && !match.ctf) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = match.bases;
    cb.addEventListener('change', () => { match.bases = cb.checked; save('cr-match', match); onChange(); });
    row('Team bases', cb).title = 'Each team spawns at its own base, with the pickups the same on every side (where the level has room)';
  }
}

/** Does this level give each team a base, with the current setup? */
export function basesFor(def: LevelDef, defaults: SimConfig): boolean {
  return match.teams >= 2 && (match.bases || match.ctf) && maxTeamBases({ ...defaults, ...def.config } as SimConfig) >= match.teams;
}

/** The setup to start `def` with. */
export function setupFor(def: LevelDef): GameSetup {
  const s: GameSetup = { name: player.name, color: player.color };
  if (def.mode !== 'sandbox') return s;
  const teams = match.teams >= 2 ? match.teams : 0;
  if (teams) {
    const auto = splitBots(def.bots ?? 0, teams, match.myTeam);
    return { ...s, teams, myTeam: match.myTeam, bases: match.bases || match.ctf, ctf: match.ctf, bots: auto.map((a, t) => match.bots[t] ?? a) };
  }
  return { ...s, ...(match.bots[0] !== null && match.bots[0] !== undefined ? { bots: [match.bots[0]] } : {}) };
}
