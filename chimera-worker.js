// Renders sounds with CHIMERA, the physical-modelling voice synthesizer by Jameson Hodge
// (https://www.chimera.audio, MIT License, see CHIMERA-LICENSE.txt). chimera.wasm is CHIMERA's
// own engine (crates/chimera-wasm of github.com/jamesondh/chimera-vocal-synth), unmodified; this
// worker only drives its C ABI the way CHIMERA's web app does (src/wasm/*.ts there).
//
// Message in:  { id, wasm: url, sampleRate, jobs: Job[] }
//   Job: { type: 'song', notes: [{ midi, beats, syl }], bpm, body: { female, child }, vibrato, source? }
//      | { type: 'hit', beat: 'B' | 'Pf' | ..., note?, accent?, body, len }
//      | { type: 'say', text, body, f0, rate? }            English text, spoken (CHIMERA's speech planner)
//      | { type: 'lyrics', text, midi, beats, bpm, body, vibrato, source? }   text sung a syllable per note
//   Text jobs need { dict: url } in the message (CHIMERA's CMU dictionary, loaded once).
//   source: { breathiness?, tension?, roughness?, fry?, voiced?, brightness?, vibratoRate? }
// Messages out: { id, i, data: Float32Array, frames } per job, then { id, done: true }
//   (or { id, error }). frames: the airway over time, for drawing it (see FRAME below).
'use strict';

let ex = null;
let loading = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

function load(url) {
  if (!loading) {
    loading = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`chimera.wasm: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => WebAssembly.instantiate(b, {}))
      .then((m) => {
        ex = m.instance.exports;
      });
    loading.catch(() => (loading = null));
  }
  return loading;
}

let dictLoading = null;
function loadDict(url) {
  if (!dictLoading) {
    dictLoading = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`dictionary: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => {
        const u = new Uint8Array(b);
        // some servers inflate .gz themselves
        if (u[0] !== 0x1f || u[1] !== 0x8b) return dec.decode(u);
        return new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      })
      .then((text) => call('g2pLoad', { text }));
    dictLoading.catch(() => (dictLoading = null));
  }
  return dictLoading;
}

function call(fn, args) {
  const b = enc.encode(JSON.stringify(Object.assign({ fn }, args)));
  const p = ex.chimera_alloc(b.length);
  new Uint8Array(ex.memory.buffer, p, b.length).set(b);
  const st = ex.chimera_call(p, b.length);
  ex.chimera_free(p, b.length);
  const v = JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, ex.chimera_result_ptr(), ex.chimera_result_len())));
  if (st !== 0) throw new Error(`chimera ${fn}: ${v.error}`);
  return v;
}

// gesture records, layout version 1 (CHIMERA's src/wasm/wire.ts)
const KEYS = ['jaw', 'tbX', 'tbY', 'ttX', 'ttY', 'ttCurl', 'root', 'lipAp', 'lipProt', 'lipWidth', 'labiodental', 'velum',
  'larynx', 'epilarynx', 'ventricular', 'lateral', 'dorsum', 'abduction', 'closure', 'breath', 'f0', 'vibrato'];
const REC = 272;
function schedule(h, gestures) {
  const n = Math.min(gestures.length, 4000);
  const base = ex.engine_records(h);
  const dv = new DataView(ex.memory.buffer, base, n * REC);
  const by = new Uint8Array(ex.memory.buffer, base, n * REC);
  for (let i = 0; i < n; i++) {
    const g = gestures[i];
    const o = i * REC;
    const head = [g.t0, g.t1, g.rampIn, g.rampOut, g.strength, g.speed ?? NaN, g.releaseHold ?? NaN, g.tag ?? NaN];
    for (let j = 0; j < 8; j++) dv.setFloat64(o + j * 8, head[j], true);
    for (let k = 0; k < KEYS.length; k++) {
      const v = g.targets[KEYS[k]];
      dv.setFloat64(o + 64 + k * 8, v === undefined || v === null ? NaN : v, true);
    }
    by[o + 240] = 255;
  }
  ex.engine_schedule(h, n, 0.02, 1);
}

// source values in engine_set_source order (NaN: unchanged)
const SOURCE = ['f0', 'glide', 'pressure', 'breathiness', 'tension', 'fry', 'roughness', 'vibratoDepth', 'vibratoRate', 'drift', 'voiced', 'brightness'];
function setSource(h, src) {
  if (!src) return;
  const v = new Float64Array(ex.memory.buffer, ex.engine_values(h), 32);
  for (let i = 0; i < SOURCE.length; i++) {
    const x = src[SOURCE[i]];
    v[i] = x === undefined ? NaN : typeof x === 'boolean' ? (x ? 1 : 0) : x;
  }
  ex.engine_set_source(h);
}

// The airway every FRAME samples: NODES cross-section areas (glottis → lips) and the pressure
// in them, plus jaw and lip opening, output level and turbulence.
const FRAME = 1470; // 30 per second at 44.1 kHz
const NODES = 32;
const HEADER = 16;

function resample(src, out, o) {
  const n = src.length;
  for (let i = 0; i < NODES; i++) {
    const p = (i / (NODES - 1)) * (n - 1);
    const j = Math.floor(p);
    const a = src[j];
    const b = src[Math.min(n - 1, j + 1)];
    out[o + i] = a + (b - a) * (p - j);
  }
}

function render(h, sr, seconds) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const nf = Math.floor(n / FRAME);
  const area = new Float32Array(nf * NODES);
  const press = new Float32Array(nf * NODES);
  const jaw = new Float32Array(nf);
  const lip = new Float32Array(nf);
  const rms = new Float32Array(nf);
  const noise = new Float32Array(nf);
  for (let f = 0, i = 0; i < n; f++) {
    const k = Math.min(FRAME, n - i);
    const p = ex.engine_render(h, k);
    out.set(new Float32Array(ex.memory.buffer, p, k), i);
    i += k;
    if (f >= nf) continue;
    const t = new Float64Array(ex.memory.buffer, ex.engine_telemetry(h));
    const nA = t[11];
    const nPh = t[12];
    const nOr = t[13];
    const nodes = nPh + nOr;
    const aOff = HEADER + nA;
    const pOff = aOff + nodes;
    resample(t.subarray(aOff, aOff + nodes), area, f * NODES);
    resample(t.subarray(pOff, pOff + nodes), press, f * NODES);
    jaw[f] = t[HEADER];
    lip[f] = t[HEADER + 7];
    rms[f] = t[6];
    noise[f] = t[7];
  }
  return { out, frames: { hop: FRAME, n: nf, nodes: NODES, area, press, jaw, lip, rms, noise } };
}

/** Drop the silence before the sound (a pad plays at once), keeping the frames in step. */
function trim(r, sr) {
  const d = r.out;
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-6) return r;
  let a = 0;
  while (a < d.length && Math.abs(d[a]) < peak * 0.02) a++;
  const fr = r.frames;
  const skip = Math.max(0, Math.floor((a - sr * 0.004) / fr.hop));
  const s = skip * fr.hop;
  const cut = (x, w) => x.slice(skip * w);
  return {
    out: d.slice(s),
    frames: Object.assign({}, fr, {
      n: fr.n - skip, area: cut(fr.area, fr.nodes), press: cut(fr.press, fr.nodes),
      jaw: cut(fr.jaw, 1), lip: cut(fr.lip, 1), rms: cut(fr.rms, 1), noise: cut(fr.noise, 1),
    }),
  };
}

function voice(sr, body) {
  const h = ex.engine_new(sr);
  if (body) ex.engine_set_body(h, body.female || 0, body.child || 0);
  return h;
}

function job(j, sr) {
  if (j.type === 'song') {
    const h = voice(sr, j.body);
    try {
      setSource(h, j.source);
      render(h, sr, 0.05);
      const plan = call('planSong', { notes: j.notes, options: { body: j.body, bpm: j.bpm, t0: 0.25, vibrato: j.vibrato ?? 20 } });
      schedule(h, plan.gestures);
      return trim(render(h, sr, plan.end + (j.tail ?? 0.35)), sr);
    } finally {
      ex.engine_free(h);
    }
  }
  if (j.type === 'hit') {
    const h = voice(sr, j.body);
    try {
      setSource(h, j.source);
      render(h, sr, 0.3);
      const rec = ex.engine_records(h);
      const by = new Uint8Array(ex.memory.buffer, rec, 48);
      const dv = new DataView(ex.memory.buffer, rec, 48);
      const id = enc.encode(j.beat);
      by[0] = id.length;
      by.set(id, 1);
      dv.setFloat64(32, j.note ?? NaN, true);
      dv.setFloat64(40, j.accent ?? NaN, true);
      ex.engine_beat_hit(h);
      return trim(render(h, sr, j.len ?? 0.6), sr);
    } finally {
      ex.engine_free(h);
    }
  }
  if (j.type === 'say') {
    const phrases = call('g2pPhrases', { text: j.text });
    if (!phrases.length) throw new Error('nothing to say');
    const h = voice(sr, j.body);
    try {
      setSource(h, Object.assign({ f0: j.f0 }, j.source || {}));
      render(h, sr, 0.05);
      const inputs = phrases.map((p) => ({ segments: p.segments, intonation: p.intonation, pause: p.pause }));
      const plan = call('planPhrases', { phrases: inputs, options: { body: j.body, t0: 0.05, f0: j.f0, rate: j.rate ?? 1 } });
      schedule(h, plan.gestures);
      return trim(render(h, sr, plan.end + 0.3), sr);
    } finally {
      ex.engine_free(h);
    }
  }
  if (j.type === 'lyrics') {
    const syl = call('lyricsToSyllables', { text: j.text });
    if (!syl.length) throw new Error('nothing to sing');
    const notes = syl.map((s) => ({ midi: j.midi, beats: j.beats, syl: s }));
    return job({ type: 'song', notes, bpm: j.bpm, body: j.body, vibrato: j.vibrato, source: j.source }, sr);
  }
  throw new Error(`unknown job ${j.type}`);
}

self.onmessage = async (e) => {
  const { id, wasm, dict, sampleRate, jobs } = e.data;
  try {
    await load(wasm);
    if (dict && jobs.some((j) => j.type === 'say' || j.type === 'lyrics')) await loadDict(dict);
    for (let i = 0; i < jobs.length; i++) {
      const r = job(jobs[i], sampleRate);
      const f = r.frames;
      self.postMessage({ id, i, data: r.out, frames: f }, [r.out.buffer, f.area.buffer, f.press.buffer, f.jaw.buffer, f.lip.buffer, f.rms.buffer, f.noise.buffer]);
    }
    self.postMessage({ id, done: true });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
