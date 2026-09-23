import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { AppError } from "../errors.js";

const MAX_ENTRIES = 251;
const MAX_ARCHIVE_BYTES = 3_750 * 1024 * 1024;
const encoder = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name: Buffer, size: number, checksum: number) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
  header.writeUInt16LE(0, 8); // Stored; MP3/PNG/JPEG are already compressed.
  header.writeUInt16LE(0, 10); // Deterministic 1980-01-01 timestamp.
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function directoryHeader(entry: { name: Buffer; size: number; checksum: number; offset: number }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(entry.checksum, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(0, 38); // No external file attributes.
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function validIsbn13(value: string) {
  if (!/^97[89]\d{10}$/u.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

export function googlePlayIdentifierSchemaSafe(value: string) {
  return value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
    && (!/^\d{13}$/u.test(value) || validIsbn13(value));
}

export function googlePlayCoverDimensions(bytes: Buffer, mimeType: string): { width: number; height: number; extension: "jpg" | "png" } {
  let width = 0;
  let height = 0;
  let extension: "jpg" | "png";
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    extension = "png";
  } else if (mimeType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    extension = "jpg";
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new AppError(422, "The selected cover image is malformed.");
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(offset);
      const isFrameHeader = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
      if (length < (isFrameHeader ? 7 : 2) || offset + length > bytes.length) throw new AppError(422, "The selected cover image is malformed.");
      if (isFrameHeader) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else {
    throw new AppError(422, "Google Play audiobook covers must be JPEG or PNG files.");
  }
  if (width < 1024 || height < 1024 || width > 7200 || height > 7200) {
    throw new AppError(422, "Google Play audiobook cover dimensions must be between 1,024 and 7,200 pixels on each side.");
  }
  return { width, height, extension };
}

/** ZIP32 writer for bounded, known media entries. Audio/cover bytes are streamed
 * to a private temp file so a whole audiobook is not retained in Node memory. */
export class GooglePlayAudioZip {
  readonly directory: string;
  readonly path: string;
  private readonly stream;
  private offset = 0;
  private totalBytes = 0;
  private readonly entries: Array<{ name: Buffer; size: number; checksum: number; offset: number }> = [];
  private finished = false;

  private constructor(directory: string, path: string, stream: ReturnType<typeof createWriteStream>) {
    this.directory = directory;
    this.path = path;
    this.stream = stream;
  }

  static async create() {
    const directory = await mkdtemp(join(tmpdir(), "bookworm-google-audio-"));
    const path = join(directory, "export.zip");
    const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
    await once(stream, "open");
    return new GooglePlayAudioZip(directory, path, stream);
  }

  async add(name: string, bytes: Buffer) {
    if (this.finished || this.entries.length >= MAX_ENTRIES || !bytes.length || bytes.length > 0xffffffff) {
      throw new AppError(413, "Audiobook export exceeds the supported archive limits.");
    }
    if (!/^(?:Audio\/[^/]+\.mp3|Cover\/[^/]+\.(?:jpg|png))$/u.test(name)) throw new AppError(422, "Invalid audiobook archive entry name.");
    const encodedName = encoder.encode(name);
    const projected = this.totalBytes + bytes.length + encodedName.length * 2 + 76;
    if (projected > MAX_ARCHIVE_BYTES || projected > 0xffffffff) throw new AppError(413, "Audiobook export exceeds the 3.75 GiB archive limit.");
    const entry = { name: Buffer.from(encodedName), size: bytes.length, checksum: crc32(bytes), offset: this.offset };
    await this.write(localHeader(entry.name, entry.size, entry.checksum));
    await this.write(entry.name);
    await this.write(bytes);
    this.totalBytes += bytes.length;
    this.entries.push(entry);
  }

  private async write(bytes: Buffer) {
    if (!this.stream.write(bytes)) await once(this.stream, "drain");
    this.offset += bytes.length;
  }

  async finish() {
    if (this.finished || this.entries.length < 2) throw new AppError(422, "An export needs audiobook chapters and one cover image.");
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      await this.write(directoryHeader(entry));
      await this.write(entry.name);
    }
    const directorySize = this.offset - directoryOffset;
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(this.entries.length, 8);
    footer.writeUInt16LE(this.entries.length, 10);
    footer.writeUInt32LE(directorySize, 12);
    footer.writeUInt32LE(directoryOffset, 16);
    await this.write(footer);
    this.finished = true;
    this.stream.end();
    await once(this.stream, "close");
    return await stat(this.path);
  }

  async dispose() {
    if (!this.finished) {
      this.stream.destroy();
      this.finished = true;
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}
