// PTP/MTP wire format: container framing and the few datasets we need.
// References: PIMA 15740 (PTP) and USB-IF "Media Transfer Protocol v1.1".
// All integers are little-endian; strings are length-prefixed UTF-16LE.

export const ContainerType = Object.freeze({ COMMAND: 1, DATA: 2, RESPONSE: 3, EVENT: 4 });

export const Op = Object.freeze({
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009
});

export const Rc = Object.freeze({
  OK: 0x2001,
  GeneralError: 0x2002,
  SessionNotOpen: 0x2003,
  InvalidTransactionID: 0x2004,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  IncompleteTransfer: 0x2007,
  InvalidStorageID: 0x2008,
  InvalidObjectHandle: 0x2009,
  AccessDenied: 0x200f,
  StoreNotAvailable: 0x2013,
  DeviceBusy: 0x2019,
  InvalidParentObject: 0x201a,
  InvalidParameter: 0x201d,
  SessionAlreadyOpen: 0x201e,
  TransactionCancelled: 0x201f
});

const RC_NAMES = new Map(Object.entries(Rc).map(([k, v]) => [v, k]));
const OP_NAMES = new Map(Object.entries(Op).map(([k, v]) => [v, k]));

export const rcName = (code) => RC_NAMES.get(code) ?? `0x${code.toString(16).padStart(4, "0")}`;
export const opName = (code) => OP_NAMES.get(code) ?? `0x${code.toString(16).padStart(4, "0")}`;

export const ObjectFormat = Object.freeze({ Undefined: 0x3000, Association: 0x3001 });

/** GetObjectHandles parent value meaning "objects in the root of the storage". */
export const ROOT_PARENT = 0xffffffff;

export const HEADER_SIZE = 12;

export function encodeCommand(code, transactionId, params = []) {
  if (params.length > 5) throw new Error("PTP commands take at most 5 parameters");
  const length = HEADER_SIZE + 4 * params.length;
  const buf = Buffer.alloc(length);
  buf.writeUInt32LE(length, 0);
  buf.writeUInt16LE(ContainerType.COMMAND, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(transactionId >>> 0, 8);
  params.forEach((p, i) => buf.writeUInt32LE(p >>> 0, HEADER_SIZE + 4 * i));
  return buf;
}

/** Split a complete container into header fields + payload. */
export function decodeContainer(buf) {
  if (buf.length < HEADER_SIZE) throw new Error(`Short PTP container (${buf.length} bytes)`);
  const length = buf.readUInt32LE(0);
  return {
    length,
    type: buf.readUInt16LE(4),
    code: buf.readUInt16LE(6),
    transactionId: buf.readUInt32LE(8),
    payload: buf.subarray(HEADER_SIZE, length)
  };
}

/** Response parameters are a list of UINT32 after the header. */
export function decodeParams(payload) {
  const out = [];
  for (let o = 0; o + 4 <= payload.length; o += 4) out.push(payload.readUInt32LE(o));
  return out;
}

export class DatasetReader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }
  need(n) {
    if (this.offset + n > this.buf.length) {
      throw new Error(`Truncated MTP dataset (need ${n} bytes at offset ${this.offset}, have ${this.buf.length})`);
    }
  }
  u8() { this.need(1); return this.buf.readUInt8(this.offset++); }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.offset); this.offset += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v; }
  u64() {
    this.need(8);
    const lo = this.buf.readUInt32LE(this.offset);
    const hi = this.buf.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return hi * 2 ** 32 + lo;
  }
  /** PTP string: UINT8 count of UTF-16 code units (incl. terminating NUL), then the units. */
  str() {
    const units = this.u8();
    if (units === 0) return "";
    this.need(units * 2);
    const s = this.buf.toString("utf16le", this.offset, this.offset + units * 2);
    this.offset += units * 2;
    return s.replace(/\u0000+$/, "");
  }
  u16Array() {
    const n = this.u32();
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.u16());
    return out;
  }
  u32Array() {
    const n = this.u32();
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.u32());
    return out;
  }
}

export function parseDeviceInfo(buf) {
  const r = new DatasetReader(buf);
  const info = {
    standardVersion: r.u16(),
    vendorExtensionId: r.u32(),
    vendorExtensionVersion: r.u16(),
    vendorExtensionDesc: r.str(),
    functionalMode: r.u16(),
    operationsSupported: r.u16Array(),
    eventsSupported: r.u16Array(),
    devicePropertiesSupported: r.u16Array(),
    captureFormats: r.u16Array(),
    playbackFormats: r.u16Array()
  };
  info.manufacturer = r.str();
  info.model = r.str();
  info.deviceVersion = r.str();
  info.serialNumber = r.str();
  return info;
}

export function parseStorageInfo(buf) {
  const r = new DatasetReader(buf);
  return {
    storageType: r.u16(),
    filesystemType: r.u16(),
    accessCapability: r.u16(),
    maxCapacity: r.u64(),
    freeSpaceInBytes: r.u64(),
    freeSpaceInObjects: r.u32(),
    description: r.str(),
    volumeLabel: r.str()
  };
}

export function parseObjectInfo(buf) {
  const r = new DatasetReader(buf);
  const info = {
    storageId: r.u32(),
    format: r.u16(),
    protectionStatus: r.u16(),
    size: r.u32(),
    thumbFormat: r.u16(),
    thumbSize: r.u32(),
    thumbWidth: r.u32(),
    thumbHeight: r.u32(),
    imageWidth: r.u32(),
    imageHeight: r.u32(),
    imageBitDepth: r.u32(),
    parent: r.u32(),
    associationType: r.u16(),
    associationDesc: r.u32(),
    sequenceNumber: r.u32(),
    filename: r.str()
  };
  // Dates/keywords are optional for our purposes; tolerate devices that truncate them.
  try {
    info.captureDate = r.str();
    info.modificationDate = r.str();
    info.keywords = r.str();
  } catch {
    // ignore
  }
  info.isFolder = info.format === ObjectFormat.Association;
  return info;
}

export function parseUint32Array(buf) {
  return new DatasetReader(buf).u32Array();
}
