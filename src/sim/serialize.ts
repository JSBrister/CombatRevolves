// Snapshots and a compact, lossless binary serializer for SimState.
//
// snapshot/restore are deep copies via encode/decode, which is a schema-less tagged binary format with key interning:
// object keys are written once and then referenced by index, numbers use the
// smallest exact encoding (u8 / i32 / f64), so -0, NaN and full precision
// survive. Good enough for rollback buffers now and the wire later.

import type { SimState } from './types';

/** A snapshot is the compact binary encoding (lossless, unlike JSON which drops -0). */
export type Snapshot = Uint8Array;

export function snapshot(state: SimState): Snapshot {
  return encode(state);
}

export function restore(snap: Snapshot): SimState {
  return decode<SimState>(snap);
}

export function cloneState(state: SimState): SimState {
  return restore(snapshot(state));
}

const T_NULL = 0, T_FALSE = 1, T_TRUE = 2, T_U8 = 3, T_I32 = 4, T_F64 = 5, T_STR = 6, T_ARR = 7, T_OBJ = 8;
const T_KEYNEW = 9, T_KEYREF = 10;
// short forms (most arrays, objects and key tables are small): a one-byte count or index
const T_ARR8 = 11, T_OBJ8 = 12, T_KEYREF8 = 13, T_I16 = 14;

class Writer {
  buf = new ArrayBuffer(1024);
  view = new DataView(this.buf);
  pos = 0;
  keys = new Map<string, number>();
  ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  str(s: string) {
    this.u32(s.length);
    this.ensure(s.length * 2);
    for (let i = 0; i < s.length; i++) { this.view.setUint16(this.pos, s.charCodeAt(i), true); this.pos += 2; }
  }
  value(v: unknown): void {
    if (v === null || v === undefined) return this.u8(T_NULL);
    if (v === false) return this.u8(T_FALSE);
    if (v === true) return this.u8(T_TRUE);
    if (typeof v === 'number') {
      if (Number.isInteger(v) && !Object.is(v, -0)) {
        if (v >= 0 && v < 256) { this.u8(T_U8); return this.u8(v); }
        if (v >= -32768 && v <= 32767) { this.u8(T_I16); this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; return; }
        if (v >= -2147483648 && v <= 2147483647) { this.u8(T_I32); return this.i32(v); }
      }
      this.u8(T_F64);
      return this.f64(v);
    }
    if (typeof v === 'string') { this.u8(T_STR); return this.str(v); }
    if (Array.isArray(v)) {
      if (v.length < 256) { this.u8(T_ARR8); this.u8(v.length); } else { this.u8(T_ARR); this.u32(v.length); }
      for (const x of v) this.value(x);
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      if (entries.length < 256) { this.u8(T_OBJ8); this.u8(entries.length); } else { this.u8(T_OBJ); this.u32(entries.length); }
      for (const [k, x] of entries) {
        const ref = this.keys.get(k);
        if (ref !== undefined && ref < 256) { this.u8(T_KEYREF8); this.u8(ref); }
        else if (ref !== undefined) { this.u8(T_KEYREF); this.u32(ref); }
        else { this.keys.set(k, this.keys.size); this.u8(T_KEYNEW); this.str(k); }
        this.value(x);
      }
      return;
    }
    throw new Error(`encode: unsupported ${typeof v}`);
  }
}

class Reader {
  view: DataView;
  pos = 0;
  keys: string[] = [];
  constructor(bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u8() { return this.view.getUint8(this.pos++); }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  str() {
    const n = this.u32();
    let s = '';
    for (let i = 0; i < n; i++) { s += String.fromCharCode(this.view.getUint16(this.pos, true)); this.pos += 2; }
    return s;
  }
  value(): unknown {
    const t = this.u8();
    switch (t) {
      case T_NULL: return null;
      case T_FALSE: return false;
      case T_TRUE: return true;
      case T_U8: return this.u8();
      case T_I32: { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
      case T_F64: { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
      case T_STR: return this.str();
      case T_I16: { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
      case T_ARR: case T_ARR8: { const n = t === T_ARR ? this.u32() : this.u8(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.value(); return a; }
      case T_OBJ: case T_OBJ8: {
        const n = t === T_OBJ ? this.u32() : this.u8();
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const kt = this.u8();
          let k: string;
          if (kt === T_KEYNEW) { k = this.str(); this.keys.push(k); } else k = this.keys[kt === T_KEYREF8 ? this.u8() : this.u32()];
          o[k] = this.value();
        }
        return o;
      }
    }
    throw new Error(`decode: bad tag ${t}`);
  }
}

export function encode(value: unknown): Uint8Array {
  const w = new Writer();
  w.value(value);
  return new Uint8Array(w.buf.slice(0, w.pos));
}

export function decode<T = SimState>(bytes: Uint8Array): T {
  return new Reader(bytes).value() as T;
}
