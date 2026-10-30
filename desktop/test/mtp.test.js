import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFakeMtpDevice } from "./helpers/fakeMtpDevice.js";
import { MtpSession } from "../src/main/kindle/mtp/session.js";
import { UsbBulkTransport } from "../src/main/kindle/mtp/usbTransport.js";
import { downloadVocabOverUsb, findMtpInterface, KindleAccessError } from "../src/main/kindle/mtp/usbBackend.js";
import { Op } from "../src/main/kindle/mtp/ptp.js";

const kindleTree = (vocab) => ({
  documents: { "book.azw3": Buffer.from("not really a book") },
  ".bcache": {},
  system: {
    "version.txt": Buffer.from("5.17.1"),
    thumbnails: {},
    vocabulary: { booklet_control: Buffer.alloc(0), "vocab.db": vocab }
  }
});

const entryFor = (device) => ({ device, mtp: findMtpInterface(device) });

async function download(device) {
  return downloadVocabOverUsb(entryFor(device), { releaseCameraDaemon: false });
}

test("finds the Kindle's vendor-specific MTP interface", () => {
  const device = createFakeMtpDevice({ storages: [] });
  assert.deepEqual(findMtpInterface(device), {
    interfaceNumber: 0,
    alternateSetting: 0,
    inEndpoint: 1,
    outEndpoint: 1,
    packetSize: 512,
    interfaceClass: 0xff,
    interfaceName: "MTP"
  });
});

// (12-byte header + payload) landing exactly on a packet boundary forces the ZLP paths.
for (const [label, size, sendZlp] of [
  ["odd size", 1_982_464 + 37, true],
  ["data ends on a packet boundary, device sends ZLP", 512 * 3000 - 12, true],
  ["data ends on a packet boundary, device sends no ZLP", 512 * 3000 - 12, false],
  ["bigger than one USB read (3.5 MB)", 3.5 * 1024 * 1024, true],
  ["tiny file", 100, false]
]) {
  test(`downloads vocab.db over MTP: ${label}`, async () => {
    const vocab = crypto.randomBytes(size);
    const device = createFakeMtpDevice({
      storages: [{ id: 0x10001, description: "Internal Storage", tree: kindleTree(vocab) }],
      sendZlp
    });
    const res = await download(device);
    assert.equal(res.storage, "Internal Storage");
    assert.equal(res.deviceInfo.model, "Kindle Paperwhite");
    assert.ok(res.bytes.equals(vocab), "downloaded bytes must match");
    // Session is opened and closed, interface released, device closed.
    const codes = device.log.commands.map((c) => c.code);
    assert.equal(codes[0], Op.GetDeviceInfo);
    assert.equal(codes[1], Op.OpenSession);
    assert.equal(codes.at(-1), Op.CloseSession);
    assert.equal(device.claimed.size, 0);
    assert.equal(device.opened, false);
  });
}

test("transaction ids follow the spec: 0 for OpenSession, then 1, 2, 3…", async () => {
  const device = createFakeMtpDevice({
    storages: [{ id: 0x10001, description: "Internal Storage", tree: kindleTree(Buffer.from("db")) }]
  });
  await download(device);
  const tids = device.log.transactionIds;
  assert.deepEqual(tids.slice(0, 2), [0, 0]); // GetDeviceInfo, OpenSession
  assert.deepEqual(tids.slice(2), tids.slice(2).map((_, i) => i + 1));
});

test("matches folder names case-insensitively and skips storages without vocab.db", async () => {
  const vocab = Buffer.from("SQLite format 3\u0000...");
  const device = createFakeMtpDevice({
    storages: [
      { id: 0x10001, description: "SD Card", tree: { music: {} } },
      { id: 0x20001, description: "Internal Storage", tree: { System: { Vocabulary: { "VOCAB.DB": vocab } } } }
    ]
  });
  const res = await download(device);
  assert.equal(res.storage, "Internal Storage");
  assert.ok(res.bytes.equals(vocab));
});

test("explains when the system folder is not exposed over MTP", async () => {
  const device = createFakeMtpDevice({
    storages: [{ id: 0x10001, description: "Internal Storage", tree: { documents: {}, fonts: {} } }]
  });
  await assert.rejects(download(device), (e) => {
    assert.ok(e instanceof KindleAccessError);
    assert.match(e.message, /not visible over USB/);
    assert.match(e.hint, /"system" not found/);
    return true;
  });
  assert.equal(device.opened, false);
});

test("continues when the device says a session is already open", async () => {
  const vocab = Buffer.from("vocab");
  const device = createFakeMtpDevice({
    storages: [{ id: 0x10001, description: "Internal Storage", tree: kindleTree(vocab) }],
    sessionAlreadyOpen: true
  });
  const res = await download(device);
  assert.ok(res.bytes.equals(vocab));
});

test("reports a busy device with a readable error", { skip: process.platform === "darwin" }, async () => {
  const device = createFakeMtpDevice({ storages: [], claimError: "Device or resource busy" });
  await assert.rejects(download(device), (e) => e instanceof KindleAccessError && /in use|another program/i.test(e.message));
  assert.equal(device.opened, false);
});

test("findPath stops listing siblings once it found the match", async () => {
  const device = createFakeMtpDevice({
    storages: [{ id: 1, description: "Internal Storage", tree: { system: { a: {}, b: {}, vocabulary: { "vocab.db": Buffer.from("x") } }, zzz: {} } }]
  });
  const session = new MtpSession(new UsbBulkTransport(device, findMtpInterface(device)));
  await session.openSession();
  const { found } = await session.findPath(1, ["system", "vocabulary", "vocab.db"]);
  assert.equal(found.filename, "vocab.db");
  const infoCalls = device.log.commands.filter((c) => c.code === Op.GetObjectInfo).length;
  assert.equal(infoCalls, 1 + 3 + 1); // "system" is first at the root, "vocabulary" third in system/
});
