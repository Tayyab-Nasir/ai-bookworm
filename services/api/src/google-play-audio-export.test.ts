import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { googlePlayCoverDimensions, googlePlayIdentifierSchemaSafe, GooglePlayAudioZip } from "./lib/google-play-audio-export.js";

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("Google Play export validates safe ISBN and publisher identifiers", () => {
  assert.equal(googlePlayIdentifierSchemaSafe("9780306406157"), true);
  assert.equal(googlePlayIdentifierSchemaSafe("9780306406158"), false);
  assert.equal(googlePlayIdentifierSchemaSafe("GGKEYa1b2c3"), true);
  for (const value of ["../book", "x/y", "a.zip", "", "  "]) assert.equal(googlePlayIdentifierSchemaSafe(value), false);
});

test("Google Play cover must be JPEG/PNG with pixel bounds", () => {
  const cover = png(1024, 1400);
  assert.deepEqual(googlePlayCoverDimensions(cover, "image/png"), { width: 1024, height: 1400, extension: "png" });
  assert.throws(() => googlePlayCoverDimensions(png(1023, 1400), "image/png"), /dimensions/);
  assert.throws(() => googlePlayCoverDimensions(png(7201, 1400), "image/png"), /dimensions/);
  assert.throws(() => googlePlayCoverDimensions(cover, "image/webp"), /JPEG or PNG/);
  assert.throws(() => googlePlayCoverDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02]), "image/jpeg"), /malformed/);
});

test("archive uses Google Play audio/cover folders, ordered names and stored media", async () => {
  const archive = await GooglePlayAudioZip.create();
  try {
    await archive.add("Audio/9780306406157_ch1.mp3", Buffer.from("ID3 chapter one"));
    await archive.add("Audio/9780306406157_ch2.mp3", Buffer.from("ID3 chapter two"));
    await archive.add("Cover/9780306406157.png", png(1024, 1024));
    const result = await archive.finish();
    assert.ok(result.size > 22);
    const bytes = await readFile(archive.path);
    assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
    const expected = [
      ["Audio/9780306406157_ch1.mp3", Buffer.from("ID3 chapter one")],
      ["Audio/9780306406157_ch2.mp3", Buffer.from("ID3 chapter two")],
      ["Cover/9780306406157.png", png(1024, 1024)],
    ] as const;
    let offset = 0;
    for (const [name, content] of expected) {
      assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
      assert.equal(bytes.readUInt16LE(offset + 8), 0, "media entries are stored without lossy recompression");
      const filenameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const actualName = bytes.subarray(offset + 30, offset + 30 + filenameLength).toString("utf8");
      assert.equal(actualName, name);
      const dataStart = offset + 30 + filenameLength + extraLength;
      assert.deepEqual(bytes.subarray(dataStart, dataStart + content.length), content);
      offset = dataStart + content.length;
    }
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "central directory follows chapter and cover bytes");
    await assert.rejects(archive.add("../outside.mp3", Buffer.from("x")), /limits|entry name/);
  } finally {
    await archive.dispose();
  }
});
