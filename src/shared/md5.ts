/** Incremental MD5 for checksum verification without buffering a download. */
export class Md5 {
  private state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private length = 0;
  private done = false;

  update(input: Uint8Array): this {
    if (this.done) throw new Error('MD5 hash already finalized');
    let offset = 0;
    this.length += input.length;
    if (this.buffered) {
      const take = Math.min(64 - this.buffered, input.length);
      this.buffer.set(input.subarray(0, take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) { this.process(this.buffer); this.buffered = 0; }
    }
    while (offset + 64 <= input.length) {
      this.process(input.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < input.length) {
      this.buffer.set(input.subarray(offset));
      this.buffered = input.length - offset;
    }
    return this;
  }

  digest(): string {
    if (this.done) throw new Error('MD5 hash already finalized');
    const bits = this.length * 8;
    const padding = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered);
    padding[0] = 0x80;
    this.update(padding);
    const tail = new Uint8Array(8);
    let value = bits;
    for (let i = 0; i < 8; i++) { tail[i] = value & 0xff; value = Math.floor(value / 256); }
    this.update(tail);
    this.done = true;
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      const word = this.state[i];
      out[i * 4] = word & 0xff;
      out[i * 4 + 1] = word >>> 8;
      out[i * 4 + 2] = word >>> 16;
      out[i * 4 + 3] = word >>> 24;
    }
    return Array.from(out, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private process(block: Uint8Array): void {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const p = i * 4;
      words[i] = (block[p] | block[p + 1] << 8 | block[p + 2] << 16 | block[p + 3] << 24) >>> 0;
    }
    const shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let [a, b, c, d] = this.state;
    for (let i = 0; i < 64; i++) {
      let f: number; let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const k = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
      const sum = (a + f + k + words[g]) >>> 0;
      const rotated = ((sum << shifts[i]) | (sum >>> (32 - shifts[i]))) >>> 0;
      a = d; d = c; c = b; b = (b + rotated) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
  }
}
