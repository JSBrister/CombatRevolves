// Custom level builder: a form over the same level data the built-in levels
// use (a config plus a seed), and a shareable link that encodes the settings.

import type { LevelDef, SimConfig } from '../sim';

export type Shape = 'ring' | 'band' | 'sphere' | 'ridge' | 'torus' | 'halfpipe' | 'log' | 'planet' | 'nested' | 'twin';

export interface CustomSettings {
  shape: Shape;
  R: number;
  width: number; // half-width of the floor (or the tube's radius)
  g: number;
  walls: 'varied' | 'full' | 'low';
  floor: SimConfig['floorTexture'];
  hills: number;
  hillHeight: number;
  mountains: number;
  mountainHeight: number;
  bases: number;
  holes: number;
  deck: number;
  windows: number;
  spinChange: number;
  spinPeriod: number;
  planetSpin: number; // planet worlds: how much of g the spin cancels at the equator
  planet: number; // planet pull, as a fraction of g
  air: 'none' | 'hazy' | 'thick';
  bots: number;
  bikes: number;
  seed: number;
}

export const CUSTOM_DEFAULTS: CustomSettings = {
  shape: 'ring', R: 150, width: 25, g: 9.81, walls: 'varied', floor: 'auto', hills: 0, hillHeight: 8, mountains: 0, mountainHeight: 40,
  bases: 0, holes: 0, deck: 0, windows: 0, spinChange: 0, spinPeriod: 90, planetSpin: 0.4, planet: 0, air: 'none', bots: 3, bikes: -1, seed: 1,
};

type Field =
  | { key: keyof CustomSettings; label: string; min: number; max: number; step: number; note?: string; ringOnly?: boolean }
  | { key: keyof CustomSettings; label: string; options: [string, string][]; ringOnly?: boolean };

const FIELDS: Field[] = [
  { key: 'shape', label: 'Shape', options: [['ring', 'Ring (cylinder)'], ['band', 'Sphere band (bowl)'], ['sphere', 'Whole sphere'], ['ridge', 'Ridge (Lambda)'],
    ['torus', 'Inside a torus'], ['halfpipe', 'Half-pipe (half torus)'], ['log', 'Outside a torus (the log)'], ['planet', 'Outside a planet'], ['nested', 'Nested spheres (ball in a shell)'], ['twin', 'Twin rings (counter-rotating)']] },
  { key: 'R', label: 'Radius (m)', min: 20, max: 3000, step: 5 },
  { key: 'width', label: 'Half-width / tube radius (m)', min: 6, max: 1500, step: 1 },
  { key: 'g', label: 'Gravity at the floor (m/s²)', min: 1, max: 30, step: 0.1 },
  { key: 'walls', label: 'Rim walls', options: [['varied', 'Varied (some low)'], ['full', 'Full height'], ['low', 'Low curbs (fall off!)']] },
  { key: 'floor', label: 'Floor', options: [['auto', 'Automatic'], ['deck', 'Deck plating'], ['grass', 'Grass'], ['sand', 'Sand'], ['snow', 'Snow'], ['rock', 'Rock']] },
  { key: 'hills', label: 'Hills', min: 0, max: 120, step: 1, ringOnly: true },
  { key: 'hillHeight', label: 'Hill height (m)', min: 1, max: 60, step: 1, ringOnly: true },
  { key: 'mountains', label: 'Mountains', min: 0, max: 30, step: 1, ringOnly: true },
  { key: 'mountainHeight', label: 'Mountain height (m)', min: 10, max: 300, step: 5, ringOnly: true },
  { key: 'bases', label: 'Bases', min: 0, max: 20, step: 1, ringOnly: true },
  { key: 'holes', label: 'Holes in the floor', min: 0, max: 60, step: 1, ringOnly: true },
  { key: 'deck', label: 'Upper deck height (m, 0 = none)', min: 0, max: 30, step: 1, ringOnly: true },
  { key: 'windows', label: "O'Neill windows", min: 0, max: 6, step: 1, ringOnly: true },
  { key: 'spinChange', label: 'Spin change per cycle (1 = stops, 2 = reverses)', min: 0, max: 2, step: 0.05 },
  { key: 'spinPeriod', label: 'Spin cycle (s)', min: 10, max: 600, step: 5 },
  { key: 'planetSpin', label: 'Planet: spin (fraction of g at equator)', min: 0, max: 0.95, step: 0.05 },
  { key: 'planet', label: 'Planet pull (fraction of g)', min: 0, max: 0.95, step: 0.05 },
  { key: 'air', label: 'Atmosphere', options: [['none', 'Vacuum'], ['hazy', 'Hazy'], ['thick', 'Thick']] },
  { key: 'bots', label: 'Bots', min: 0, max: 12, step: 1 },
  { key: 'bikes', label: 'Hover-bikes (-1 = by size)', min: -1, max: 20, step: 1 },
  { key: 'seed', label: 'Layout seed', min: 1, max: 9999, step: 1 },
];

const isRingLike = (s: Shape) => s === 'ring' || s === 'band' || s === 'ridge' || s === 'twin';

/** The level these settings describe. */
export function customLevel(s: CustomSettings): LevelDef {
  const R = s.R;
  const c: Partial<SimConfig> = { R, g: s.g, halfWidth: s.width, floorTexture: s.floor };
  const ring = isRingLike(s.shape);
  let variedWalls = s.walls === 'varied';
  c.wallHeight = s.walls === 'low' ? 1 : 15;
  switch (s.shape) {
    case 'band': c.terrainSphere = true; c.halfWidth = Math.min(s.width, 0.9 * R); variedWalls = false; c.wallHeight = 3; break;
    case 'sphere': c.terrainSphere = true; c.halfWidth = R - 1; c.wallHeight = R; variedWalls = false; break;
    case 'ridge': c.ridgeHeight = 0.5 * R; c.ridgePlateau = Math.min(12, s.width / 4); break;
    case 'torus': c.tube = 'inside'; c.tubeRadius = Math.min(s.width, 0.45 * R); c.halfWidth = c.tubeRadius; break;
    case 'halfpipe': c.tube = 'half'; c.tubeRadius = Math.min(s.width, 0.45 * R); c.halfWidth = c.tubeRadius; break;
    case 'planet': c.world = 'planet'; c.planetSpin = s.planetSpin; break;
    case 'nested': c.world = 'planet'; c.planetSpin = 0.3; c.outerShell = 2 * R; break; // (weightless halfway out)
    case 'twin': c.twin = true; variedWalls = false; break;
    case 'log': c.tube = 'outside'; c.tubeRadius = Math.min(s.width, 0.45 * R); c.halfWidth = c.tubeRadius; break;
  }
  if (ring) {
    Object.assign(c, { bases: s.bases });
    if (s.shape !== 'twin') Object.assign(c, { hills: s.hills, hillHeight: s.hillHeight, mountains: s.mountains, mountainHeight: s.mountainHeight }); // (twin rings have flat floors)
    if (s.shape === 'ring') Object.assign(c, { floorHoles: s.holes, deckHeight: Math.min(s.deck, 0.4 * R), windows: s.windows });
  }
  if (s.spinChange > 0) Object.assign(c, { spinChange: s.spinChange, spinPeriod: s.spinPeriod });
  if (s.planet > 0) Object.assign(c, { planetPull: s.planet * s.g, planetAngle: Math.PI });
  if (s.air !== 'none') Object.assign(c, { dragType: 'quadratic', dragCoeff: s.air === 'hazy' ? 0.004 : 0.015 });
  return {
    id: 'custom', mode: 'sandbox', name: 'Custom level', seed: s.seed, config: c, bots: s.bots, variedWalls,
    ...(s.shape === 'planet' || s.shape === 'nested' ? { props: false } : {}),
    ...(s.bikes >= 0 ? { vehicles: s.bikes } : {}),
    blurb: 'Your own level.',
  };
}

/** Only the settings that differ from the defaults, as a short URL-safe string. */
export function encodeCustom(s: CustomSettings): string {
  const diff: Record<string, unknown> = {};
  for (const k of Object.keys(CUSTOM_DEFAULTS) as (keyof CustomSettings)[]) if (s[k] !== CUSTOM_DEFAULTS[k]) diff[k] = s[k];
  return btoa(JSON.stringify(diff)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCustom(str: string): CustomSettings | null {
  try {
    const json = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out = { ...CUSTOM_DEFAULTS };
    for (const f of FIELDS) {
      const v = raw[f.key];
      if (v === undefined) continue;
      if ('options' in f) { if (f.options.some(([o]) => o === v)) (out as Record<string, unknown>)[f.key] = v; }
      else if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, unknown>)[f.key] = Math.max(f.min, Math.min(f.max, v));
    }
    return out;
  } catch {
    return null;
  }
}

/** A fun, sane random level. */
export function randomCustom(): CustomSettings {
  const r = Math.random, pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const shape = pick<Shape>(['ring', 'ring', 'ring', 'band', 'sphere', 'ridge', 'torus', 'halfpipe', 'log', 'planet', 'nested', 'twin']);
  const R = pick([60, 100, 150, 250, 400, 800]);
  const s: CustomSettings = { ...CUSTOM_DEFAULTS, shape, R, seed: 1 + Math.floor(r() * 9999), bots: 2 + Math.floor(r() * 5) };
  s.width = shape === 'log' ? 10 + Math.round(r() * 10) : shape === 'torus' || shape === 'halfpipe' ? 15 + Math.round(r() * 20) : Math.round(20 + r() * Math.min(R, 120));
  if (isRingLike(shape)) {
    if (r() < 0.5) { s.hills = Math.round(r() * 30); s.hillHeight = Math.round(3 + r() * 12); }
    if (R >= 250 && r() < 0.5) { s.mountains = Math.round(2 + r() * 6); s.mountainHeight = Math.round(20 + r() * 60); }
    if (R >= 200 && r() < 0.5) s.bases = Math.round(1 + r() * 5);
    if (shape === 'ring' && r() < 0.3) s.holes = Math.round(5 + r() * 15);
    if (shape === 'ring' && r() < 0.25) s.deck = 8 + Math.round(r() * 6);
  }
  if (r() < 0.2) { s.spinChange = pick([0.5, 0.8, 1]); s.spinPeriod = pick([45, 60, 90]); }
  if (r() < 0.15) s.planet = pick([0.3, 0.6, 0.9]);
  if (r() < 0.1) s.air = 'hazy';
  return s;
}

/** Build the form into `el`; `onChange` gets the new settings after every edit. */
export function buildCustomForm(el: HTMLElement, s: CustomSettings, onChange: (s: CustomSettings) => void) {
  el.innerHTML = '';
  const rows: { f: Field; input: HTMLInputElement | HTMLSelectElement; out?: HTMLElement; row: HTMLElement }[] = [];
  const refresh = () => {
    const ring = isRingLike(s.shape);
    for (const r of rows) r.row.classList.toggle('disabled', !!r.f.ringOnly && !ring);
  };
  for (const f of FIELDS) {
    const row = document.createElement('label');
    row.className = 'custom-row';
    const name = document.createElement('span');
    name.textContent = f.label;
    row.appendChild(name);
    if ('options' in f) {
      const sel = document.createElement('select');
      for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = String(s[f.key]);
      sel.addEventListener('change', () => { (s as unknown as Record<string, unknown>)[f.key] = sel.value; refresh(); onChange(s); });
      row.appendChild(sel);
      rows.push({ f, input: sel, row });
    } else {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = String(f.min); inp.max = String(f.max); inp.step = String(f.step); inp.value = String(s[f.key]);
      const out = document.createElement('output');
      out.textContent = String(s[f.key]);
      inp.addEventListener('input', () => { (s as unknown as Record<string, unknown>)[f.key] = Number(inp.value); out.textContent = inp.value; onChange(s); });
      row.append(inp, out);
      rows.push({ f, input: inp, out, row });
    }
    el.appendChild(row);
  }
  refresh();
}
