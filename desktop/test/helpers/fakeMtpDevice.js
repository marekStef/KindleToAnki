// A fake MTP responder with the same surface as a `usb` UsbDevice, emulating
// USB bulk semantics closely enough to exercise our transport:
//  - device→host transfers are split into packets of `packetSize`,
//  - a transfer that is an exact multiple of the packet size ends with a ZLP
//    (unless `sendZlp: false`, like some devices),
//  - a bulk-IN request completes on a short packet or when its length is filled.

import { ContainerType, Op, Rc, ROOT_PARENT, ObjectFormat } from "../../src/main/kindle/mtp/ptp.js";

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeUInt32LE(v % 2 ** 32); b.writeUInt32LE(Math.floor(v / 2 ** 32), 4); return b; };
const str = (s) => {
  if (!s) return Buffer.from([0]);
  const units = Buffer.from(s + "\u0000", "utf16le");
  return Buffer.concat([Buffer.from([units.length / 2]), units]);
};
const arr16 = (a) => Buffer.concat([u32(a.length), ...a.map(u16)]);
const arr32 = (a) => Buffer.concat([u32(a.length), ...a.map(u32)]);

export function encodeObjectInfo({ storageId, format, size, parent, name }) {
  return Buffer.concat([
    u32(storageId), u16(format), u16(0), u32(size),
    u16(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(parent), u16(format === ObjectFormat.Association ? 1 : 0), u32(0), u32(0),
    str(name), str(""), str("20240101T000000"), str("")
  ]);
}

/**
 * Build a device from a simple tree:
 *   { storages: [{ id, description, tree: { system: { vocabulary: { "vocab.db": Buffer } } } }] }
 */
export function createFakeMtpDevice({
  storages,
  packetSize = 512,
  sendZlp = true,
  model = "Kindle Paperwhite",
  sessionAlreadyOpen = false,
  claimError = null
} = {}) {
  const objects = new Map(); // handle -> { storageId, parent, name, data|null }
  let nextHandle = 1;
  const addTree = (storageId, parent, tree) => {
    for (const [name, value] of Object.entries(tree)) {
      const handle = nextHandle++;
      const isFile = Buffer.isBuffer(value);
      objects.set(handle, { storageId, parent, name, data: isFile ? value : null });
      if (!isFile) addTree(storageId, handle, value);
    }
  };
  for (const s of storages) addTree(s.id, 0, s.tree);

  const inPipe = []; // queued packets (Buffers, possibly empty = ZLP)
  const log = { commands: [], transactionIds: [] };
  let sessionOpen = sessionAlreadyOpen;
  let lastTid = null;

  const queueTransfer = (bytes) => {
    for (let o = 0; o < bytes.length; o += packetSize) inPipe.push(bytes.subarray(o, o + packetSize));
    if (bytes.length % packetSize === 0 && sendZlp) inPipe.push(Buffer.alloc(0));
  };
  const container = (type, code, tid, payload = Buffer.alloc(0)) => {
    const head = Buffer.alloc(12);
    head.writeUInt32LE(12 + payload.length, 0);
    head.writeUInt16LE(type, 4);
    head.writeUInt16LE(code, 6);
    head.writeUInt32LE(tid, 8);
    return Buffer.concat([head, payload]);
  };
  const respond = (code, tid, data) => {
    if (data) queueTransfer(container(ContainerType.DATA, 0, tid, data));
    queueTransfer(container(ContainerType.RESPONSE, code, tid));
  };

  function handleCommand(buf) {
    const length = buf.readUInt32LE(0);
    const code = buf.readUInt16LE(6);
    const tid = buf.readUInt32LE(8);
    const params = [];
    for (let o = 12; o < length; o += 4) params.push(buf.readUInt32LE(o));
    log.commands.push({ code, params });
    log.transactionIds.push(tid);

    if (code === Op.GetDeviceInfo) {
      const data = Buffer.concat([
        u16(100), u32(6), u16(100), str("microsoft.com: 1.0; android.com: 1.0;"), u16(0),
        arr16([Op.GetDeviceInfo, Op.OpenSession, Op.CloseSession, Op.GetStorageIDs, Op.GetStorageInfo, Op.GetObjectHandles, Op.GetObjectInfo, Op.GetObject]),
        arr16([]), arr16([]), arr16([]), arr16([0x3000, 0x3001]),
        str("Amazon"), str(model), str("5.17.1"), str("G000TEST")
      ]);
      return respond(Rc.OK, tid, data);
    }
    if (code === Op.OpenSession) {
      if (tid !== 0) return respond(Rc.InvalidTransactionID, tid);
      if (sessionOpen) return respond(Rc.SessionAlreadyOpen, tid);
      sessionOpen = true;
      lastTid = 0;
      return respond(Rc.OK, tid);
    }
    if (!sessionOpen) return respond(Rc.SessionNotOpen, tid);
    if (lastTid !== null && tid !== lastTid + 1) return respond(Rc.InvalidTransactionID, tid);
    lastTid = tid;

    switch (code) {
      case Op.CloseSession:
        sessionOpen = false;
        lastTid = null;
        return respond(Rc.OK, tid);
      case Op.GetStorageIDs:
        return respond(Rc.OK, tid, arr32(storages.map((s) => s.id)));
      case Op.GetStorageInfo: {
        const s = storages.find((x) => x.id === params[0]);
        if (!s) return respond(Rc.InvalidStorageID, tid);
        return respond(Rc.OK, tid, Buffer.concat([u16(3), u16(2), u16(0), u64(16e9), u64(12e9), u32(0xffffffff), str(s.description), str("")]));
      }
      case Op.GetObjectHandles: {
        const [storageId, , parent] = params;
        const wantedParent = parent === ROOT_PARENT ? 0 : parent;
        const handles = [...objects.entries()]
          .filter(([, o]) => o.storageId === storageId && (parent === 0 || o.parent === wantedParent))
          .map(([h]) => h);
        return respond(Rc.OK, tid, arr32(handles));
      }
      case Op.GetObjectInfo: {
        const o = objects.get(params[0]);
        if (!o) return respond(Rc.InvalidObjectHandle, tid);
        return respond(Rc.OK, tid, encodeObjectInfo({
          storageId: o.storageId,
          format: o.data ? ObjectFormat.Undefined : ObjectFormat.Association,
          size: o.data ? o.data.length : 0,
          parent: o.parent,
          name: o.name
        }));
      }
      case Op.GetObject: {
        const o = objects.get(params[0]);
        if (!o || !o.data) return respond(Rc.InvalidObjectHandle, tid);
        return respond(Rc.OK, tid, o.data);
      }
      default:
        return respond(Rc.OperationNotSupported, tid);
    }
  }

  const device = {
    vendorId: 0x1949,
    productId: 0x9981,
    productName: model,
    serialNumber: "G000TEST",
    handle: "fake-1",
    opened: false,
    claimed: new Set(),
    configuration: {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        claimed: false,
        alternate: {
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0xff,
          interfaceProtocol: 0,
          interfaceName: "MTP",
          endpoints: [
            { endpointNumber: 1, direction: "in", type: "bulk", packetSize },
            { endpointNumber: 1, direction: "out", type: "bulk", packetSize },
            { endpointNumber: 2, direction: "in", type: "interrupt", packetSize: 64 }
          ]
        }
      }]
    },
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async claimInterface(n) {
      if (claimError) throw new Error(claimError);
      this.claimed.add(n);
    },
    async releaseInterface(n) { this.claimed.delete(n); },
    async selectConfiguration() {},
    async selectAlternateInterface() {},
    async clearHalt() {},
    async nativeTransferOut(ep, timeout, data) {
      if (data.length) handleCommand(Buffer.from(data));
      return data.length;
    },
    async nativeTransferIn(ep, timeout, length) {
      if (length % packetSize !== 0) throw new Error(`babble: requested ${length} bytes, not a multiple of ${packetSize}`);
      if (!inPipe.length) throw new Error("timeout: nothing to read");
      const parts = [];
      let total = 0;
      while (inPipe.length && total + inPipe[0].length <= length) {
        const p = inPipe.shift();
        parts.push(p);
        total += p.length;
        if (p.length < packetSize) break; // short packet / ZLP ends the transfer
      }
      return new Uint8Array(Buffer.concat(parts));
    },
    log
  };
  return device;
}
