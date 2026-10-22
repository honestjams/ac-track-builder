// Little-endian growable byte buffer, plus a matching reader for tests.
// Every Assetto Corsa binary format we write (kn5, fast_lane.ai) is
// little-endian with uint32 length-prefixed UTF-8 strings.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 1 << 16) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f32s(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.f32(values[i]);
    return this;
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
    return this;
  }

  /** Raw ASCII with no length prefix (file magic). */
  magic(s: string): this {
    return this.bytes(encoder.encode(s));
  }

  /** uint32 byte length + UTF-8 bytes. */
  string(s: string): this {
    const b = encoder.encode(s);
    this.u32(b.length);
    return this.bytes(b);
  }

  /** uint32 byte length + raw bytes. */
  blob(data: Uint8Array): this {
    this.u32(data.length);
    return this.bytes(data);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class BinaryReader {
  private view: DataView;
  pos = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32s(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.f32());
    return out;
  }

  bytes(n: number): Uint8Array {
    const v = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  magic(n: number): string {
    return decoder.decode(this.bytes(n));
  }

  string(): string {
    return decoder.decode(this.bytes(this.u32()));
  }

  blob(): Uint8Array {
    return this.bytes(this.u32());
  }
}
