/* AudioWorklet processors. Kept as a plain file (not a blob URL) for iOS Safari. */

// ---------------------------------------------------------------------------
// Recorder: meters input, optionally waits for a threshold, streams PCM chunks.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = 0; // 0 idle, 1 armed (waiting for threshold), 2 recording
    this.threshold = 0;
    this.maxFrames = 0;
    this.recorded = 0;
    this.chunkL = new Float32Array(4096);
    this.chunkR = new Float32Array(4096);
    this.chunkPos = 0;
    this.pre = 2048; // pre-roll so transients are not clipped when threshold-triggered
    this.preL = new Float32Array(this.pre);
    this.preR = new Float32Array(this.pre);
    this.prePos = 0;
    this.peak = 0;
    this.meterCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'arm') {
        this.threshold = m.threshold || 0;
        this.maxFrames = m.maxFrames;
        this.recorded = 0;
        this.chunkPos = 0;
        // `at`: start on that exact audio frame (a bounce lines up with the sequencer's first step)
        this.at = m.at || 0;
        if (this.at > 0) this.state = 3;
        else if (this.threshold <= 0) this.state = 2;
        else this.state = 1;
      } else if (m.cmd === 'stop') {
        this.flush();
        this.state = 0;
        this.port.postMessage({ type: 'done' });
      }
    };
  }
  push(l, r) {
    this.chunkL[this.chunkPos] = l;
    this.chunkR[this.chunkPos] = r;
    this.chunkPos++;
    this.recorded++;
    if (this.chunkPos >= this.chunkL.length) this.flush();
    if (this.recorded >= this.maxFrames) {
      this.flush();
      this.state = 0;
      this.port.postMessage({ type: 'done' });
    }
  }
  flush() {
    if (this.chunkPos === 0) return;
    const l = this.chunkL.slice(0, this.chunkPos);
    const r = this.chunkR.slice(0, this.chunkPos);
    this.port.postMessage({ type: 'chunk', l, r }, [l.buffer, r.buffer]);
    this.chunkPos = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;
    const L = inp[0];
    const R = inp[1] || inp[0];
    let from = 0;
    if (this.state === 3) {
      from = Math.round((this.at - currentTime) * sampleRate);
      if (from < L.length) {
        this.state = 2;
        from = Math.max(0, from);
      }
    }
    for (let i = from; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > this.peak) this.peak = a;
      if (this.state === 1) {
        this.preL[this.prePos] = L[i];
        this.preR[this.prePos] = R[i];
        this.prePos = (this.prePos + 1) % this.pre;
        if (a >= this.threshold) {
          this.state = 2;
          this.port.postMessage({ type: 'triggered' });
          for (let k = 0; k < this.pre; k++) {
            const j = (this.prePos + k) % this.pre;
            this.push(this.preL[j], this.preR[j]);
          }
        }
      } else if (this.state === 2) {
        this.push(L[i], R[i]);
        if (this.state !== 2) break;
      }
    }
    if (++this.meterCount >= 12) {
      this.port.postMessage({ type: 'meter', peak: this.peak, frames: this.recorded });
      this.peak = 0;
      this.meterCount = 0;
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);

// ---------------------------------------------------------------------------
// Punch: beat repeat, reverse, tape stop, gate and bitcrush on the master bus.
class PunchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 6;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.w = 0;
    this.mode = 'none';
    this.len = 1;
    this.count = 0;
    this.anchor = 0;
    this.read = 0;
    this.rate = 1;
    this.fade = 1;
    this.gatePhase = 0;
    this.gateGain = 1;
    // continuous crush
    this.bits = 16;
    this.hold = 1;
    this.holdCount = 0;
    this.heldL = 0;
    this.heldR = 0;
    this.baseBits = 16;
    this.baseHold = 1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'crush') {
        this.baseBits = m.bits;
        this.baseHold = m.hold;
        if (this.mode !== 'crush') { this.bits = m.bits; this.hold = m.hold; }
        return;
      }
      if (m.cmd === 'fx') {
        this.mode = m.mode;
        this.len = Math.max(32, Math.floor(m.len || 4096));
        this.count = 0;
        this.anchor = this.w;
        this.read = this.w;
        this.rate = 1;
        this.gatePhase = 0;
        if (m.mode === 'crush') { this.bits = 4; this.hold = 6; }
        else { this.bits = this.baseBits; this.hold = this.baseHold; }
      }
    };
  }
  at(buf, pos) {
    const n = this.size;
    let p = pos % n;
    if (p < 0) p += n;
    const i = Math.floor(p);
    const f = p - i;
    return buf[i] * (1 - f) + buf[(i + 1) % n] * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const iL = inp && inp[0] ? inp[0] : null;
    const iR = inp && inp[1] ? inp[1] : iL;
    const size = this.size;
    for (let i = 0; i < n; i++) {
      const xl = iL ? iL[i] : 0;
      const xr = iR ? iR[i] : 0;
      this.bufL[this.w] = xl;
      this.bufR[this.w] = xr;
      let yl = xl;
      let yr = xr;
      const mode = this.mode;
      if (mode === 'repeat') {
        if (this.count >= this.len) {
          const pos = this.anchor + (this.count % this.len);
          // short crossfade at the loop seam to avoid clicks
          const ph = this.count % this.len;
          const edge = Math.min(ph, this.len - ph, 64) / 64;
          yl = this.bufL[pos % size] * edge;
          yr = this.bufR[pos % size] * edge;
        }
        this.count++;
      } else if (mode === 'reverse') {
        const ph = this.count % this.len;
        if (ph === 0) this.read = this.w;
        const pos = this.read - ph;
        const edge = Math.min(ph, this.len - ph, 64) / 64;
        yl = this.at(this.bufL, pos) * edge;
        yr = this.at(this.bufR, pos) * edge;
        this.count++;
      } else if (mode === 'tape') {
        this.rate = Math.max(0, this.rate - 1 / (sampleRate * 0.7));
        this.read += this.rate;
        yl = this.at(this.bufL, this.read) * Math.min(1, this.rate * 4);
        yr = this.at(this.bufR, this.read) * Math.min(1, this.rate * 4);
      } else if (mode === 'gate') {
        this.gatePhase = (this.gatePhase + 1) % this.len;
        const target = this.gatePhase < this.len * 0.5 ? 1 : 0;
        this.gateGain += (target - this.gateGain) * 0.01;
        yl *= this.gateGain;
        yr *= this.gateGain;
      }
      // bit crush + sample-rate reduction
      if (this.bits < 16 || this.hold > 1) {
        if (this.holdCount <= 0) {
          const q = Math.pow(2, this.bits - 1);
          this.heldL = Math.round(yl * q) / q;
          this.heldR = Math.round(yr * q) / q;
          this.holdCount = this.hold;
        }
        this.holdCount--;
        yl = this.heldL;
        yr = this.heldR;
      }
      oL[i] = yl;
      oR[i] = yr;
      this.w = (this.w + 1) % size;
    }
    return true;
  }
}
registerProcessor('punch', PunchProcessor);

// ---------------------------------------------------------------------------
// Scratch: a record under a hand. The main thread sends where the hand holds the record
// (`target`, in frames) as the knob or a finger moves, a few dozen times a second. The hand is
// not where the last event put it but on its way there: each move is spread over the time the
// events come apart, so a steady hand reads the record at a steady speed (and pitch), backwards
// included, instead of jumping and stopping on every event. Let go and the platter coasts to a
// stop, or the motor pulls it back up to speed. The crossfader cuts the output.
class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null;
    this.pos = 0;
    this.vel = 0;
    // the hand: where it is, the move it is making (from, to, over `len` frames)
    this.handPos = 0;
    this.from = 0;
    this.to = 0;
    this.len = 1;
    this.i = 1;
    this.lastMsg = -1e9;
    this.gap = sampleRate * 0.016;
    this.hand = false;
    this.motor = false;
    this.fader = 1;
    this.gain = 1;
    this.dcX = 0;
    this.dcY = 0;
    this.lp = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.buf) {
        this.buf = m.buf;
        this.pos = m.pos || 0;
        this.handPos = this.from = this.to = this.pos;
        this.i = this.len;
        this.vel = 0;
      }
      if (m.target !== undefined) this.move(m.target);
      if (m.hand !== undefined) this.hand = m.hand;
      if (m.motor !== undefined) this.motor = m.motor;
      if (m.fader !== undefined) this.fader = m.fader;
    };
  }
  move(target) {
    const now = currentFrame;
    const dt = now - this.lastMsg;
    this.lastMsg = now;
    if (!this.hand || dt > sampleRate * 0.1) {
      // the hand lands on the record where it is turning now
      this.handPos = this.pos;
      this.gap = sampleRate * 0.016;
    } else {
      // how far apart the moves come (events arrive at block edges, so it jitters)
      this.gap += (Math.max(128, Math.min(sampleRate * 0.05, dt)) - this.gap) * 0.3;
    }
    this.from = this.handPos;
    this.to = target;
    // a little longer than the gap: the next move takes over before this one ends
    this.len = Math.max(64, Math.round(this.gap * 1.25));
    this.i = 0;
    this.hand = true;
  }
  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const b = this.buf;
    if (!b) return true;
    const n = b.length;
    // the platter follows the hand closely; just enough give to round off the corners
    const follow = 1 - Math.exp(-1 / (sampleRate * 0.003));
    const coast = Math.exp(-1 / (sampleRate * 0.09));
    const spin = 1 - Math.exp(-1 / (sampleRate * 0.12));
    const fade = 1 - Math.exp(-1 / (sampleRate * 0.0015));
    for (let i = 0; i < L.length; i++) {
      if (this.hand) {
        if (this.i < this.len) {
          this.i++;
          this.handPos = this.from + (this.to - this.from) * (this.i / this.len);
        }
        const next = this.pos + (this.handPos - this.pos) * follow;
        this.vel = next - this.pos;
        this.pos = next;
      } else {
        this.vel = this.motor ? this.vel + (1 - this.vel) * spin : this.vel * coast;
        this.pos += this.vel;
        this.handPos = this.pos;
      }
      if (this.pos <= 0) { this.pos = 0; this.vel = 0; }
      if (this.pos >= n - 2) { this.pos = n - 2; this.vel = 0; }
      const k = Math.floor(this.pos);
      const f = this.pos - k;
      // 4-point interpolation: clean at slow and fast speeds alike
      const xm = b[k > 0 ? k - 1 : 0];
      const x0 = b[k];
      const x1 = b[k + 1];
      const x2 = b[k + 2 < n ? k + 2 : n - 1];
      let x = x0 + 0.5 * f * (x1 - xm + f * (2 * xm - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm)));
      // slow moves sound dull, as the stylus drags through the groove
      const sp = Math.min(1, Math.abs(this.vel) * 1.6 + 0.05);
      this.lp += (x - this.lp) * sp;
      x = this.lp;
      // the crossfader: closed up to 4% of its travel, fully open from 10% (a scratch mixer's sharp cut)
      const g = Math.max(0, Math.min(1, (this.fader - 0.04) / 0.06));
      this.gain += (g - this.gain) * fade;
      // DC blocker: a held record is silent wherever it stops
      const y = x - this.dcX + 0.995 * this.dcY;
      this.dcX = x;
      this.dcY = y;
      const v = y * this.gain;
      L[i] = v;
      if (R !== L) R[i] = v;
    }
    if (++this.tick % 3 === 0) this.port.postMessage({ pos: this.pos, vel: this.vel });
    return true;
  }
}
registerProcessor('scratch', ScratchProcessor);
