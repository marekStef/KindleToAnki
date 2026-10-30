// A small MTP initiator: just enough of the protocol to browse folders and
// download one file. Works over any transport with
//   send(buffer, timeoutMs)  and  receiveContainer(timeoutMs, onProgress)
// (see usbTransport.js for the real USB one, test/helpers for a fake device).

import {
  ContainerType,
  Op,
  Rc,
  ROOT_PARENT,
  decodeParams,
  encodeCommand,
  opName,
  parseDeviceInfo,
  parseObjectInfo,
  parseStorageInfo,
  parseUint32Array,
  rcName
} from "./ptp.js";

export class MtpError extends Error {
  constructor(message, { op, code } = {}) {
    super(message);
    this.name = "MtpError";
    this.op = op;
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class MtpSession {
  constructor(transport, { log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.transport = transport;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.sessionOpen = false;
    this.transactionId = 0;
  }

  /**
   * One command/(data)/response round trip.
   * Returns { code, params, data } where data is the device→host payload, if any.
   */
  async transaction(op, params = [], { timeoutMs = this.timeoutMs, onProgress } = {}) {
    // OpenSession (and anything before it) uses transaction id 0; afterwards 1, 2, 3, …
    const tid = this.sessionOpen ? ++this.transactionId : 0;
    await this.transport.send(encodeCommand(op, tid, params), timeoutMs);

    let container = await this.transport.receiveContainer(timeoutMs, onProgress);
    let data = null;
    if (container.type === ContainerType.DATA) {
      data = container.payload;
      container = await this.transport.receiveContainer(timeoutMs);
    }
    if (container.type !== ContainerType.RESPONSE) {
      throw new MtpError(`Unexpected container type ${container.type} in reply to ${opName(op)}`, { op });
    }
    if (container.transactionId !== tid) {
      this.log(`warn: ${opName(op)} answered with transaction id ${container.transactionId}, expected ${tid}`);
    }
    return { code: container.code, params: decodeParams(container.payload), data };
  }

  async expectOk(op, params, opts) {
    const res = await this.transaction(op, params, opts);
    if (res.code !== Rc.OK) {
      throw new MtpError(`${opName(op)} failed: ${rcName(res.code)}`, { op, code: res.code });
    }
    return res;
  }

  async getDeviceInfo() {
    const { data } = await this.expectOk(Op.GetDeviceInfo);
    return parseDeviceInfo(data);
  }

  async openSession(sessionId = 1) {
    const res = await this.transaction(Op.OpenSession, [sessionId]);
    if (res.code === Rc.SessionAlreadyOpen) {
      // A previous client did not close its session; the device keeps serving it.
      this.log("Device reports an already open session; continuing with it.");
    } else if (res.code !== Rc.OK) {
      throw new MtpError(`OpenSession failed: ${rcName(res.code)}`, { op: Op.OpenSession, code: res.code });
    }
    this.sessionOpen = true;
    this.transactionId = 0;
  }

  async closeSession() {
    if (!this.sessionOpen) return;
    try {
      await this.transaction(Op.CloseSession, [], { timeoutMs: 5_000 });
    } finally {
      this.sessionOpen = false;
    }
  }

  async getStorageIds() {
    const { data } = await this.expectOk(Op.GetStorageIDs);
    return parseUint32Array(data);
  }

  async getStorageInfo(storageId) {
    const { data } = await this.expectOk(Op.GetStorageInfo, [storageId]);
    return parseStorageInfo(data);
  }

  async getObjectHandles(storageId, parent = ROOT_PARENT) {
    const { data } = await this.expectOk(Op.GetObjectHandles, [storageId, 0, parent], { timeoutMs: 60_000 });
    return parseUint32Array(data);
  }

  async getObjectInfo(handle) {
    const { data } = await this.expectOk(Op.GetObjectInfo, [handle]);
    return { handle, ...parseObjectInfo(data) };
  }

  /** Download a whole object. onProgress(receivedBytes, totalBytes) is called while it streams in. */
  async getObject(handle, { onProgress, timeoutMs = 60_000 } = {}) {
    const { data } = await this.expectOk(Op.GetObject, [handle], { onProgress, timeoutMs });
    return data ?? Buffer.alloc(0);
  }

  /**
   * Find a child of `parent` by name (case-insensitive). Stops at the first match,
   * so we only ask for the ObjectInfo of as many siblings as necessary.
   */
  async findChild(storageId, parent, name) {
    const handles = await this.getObjectHandles(storageId, parent);
    const wanted = name.toLowerCase();
    for (const handle of handles) {
      const info = await this.getObjectInfo(handle);
      if (info.filename.toLowerCase() === wanted) return info;
    }
    return null;
  }

  /** Resolve a path like ["system", "vocabulary", "vocab.db"] inside one storage. */
  async findPath(storageId, segments) {
    let parent = ROOT_PARENT;
    let found = null;
    for (const [i, segment] of segments.entries()) {
      found = await this.findChild(storageId, parent, segment);
      if (!found) return { found: null, missing: segments.slice(0, i + 1).join("/") };
      parent = found.handle;
    }
    return { found, missing: null };
  }
}
