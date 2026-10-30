// MTP over USB bulk endpoints using the `usb` package (node-usb, nusb backend).
//
// Bulk-IN reads always request a multiple of the endpoint's packet size; a read
// can therefore end on a short packet, on a zero-length packet (ZLP) that
// terminates a transfer whose size is a multiple of the packet size, or even
// carry the tail of a data phase together with the following response. We keep
// a byte queue and cut whole containers out of it, which handles all of those.

import { HEADER_SIZE, decodeContainer } from "./ptp.js";
import { MtpError } from "./session.js";

const MAX_READ = 1024 * 1024; // per USB request; a multiple of every bulk packet size
const MAX_CONTAINER = 512 * 1024 * 1024; // sanity limit for vocab.db-sized objects

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  peek(n) {
    if (this.chunks[0]?.length >= n) return this.chunks[0].subarray(0, n);
    return Buffer.concat(this.chunks, this.length).subarray(0, n);
  }
  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }
  clear() {
    this.chunks = [];
    this.length = 0;
  }
}

export class UsbBulkTransport {
  /**
   * @param {object} device  an opened `usb` UsbDevice with the interface claimed
   * @param {{inEndpoint:number,outEndpoint:number,packetSize:number}} opts
   */
  constructor(device, { inEndpoint, outEndpoint, packetSize }) {
    this.device = device;
    this.inEndpoint = inEndpoint;
    this.outEndpoint = outEndpoint;
    this.packetSize = packetSize > 0 ? packetSize : 512;
    this.queue = new ByteQueue();
  }

  async send(buf, timeoutMs) {
    const written = await this.device.nativeTransferOut(this.outEndpoint, timeoutMs, new Uint8Array(buf));
    if (written < 0) {
      await this.clearHalt("out");
      throw new MtpError("The Kindle refused a USB command (endpoint stalled).");
    }
    if (buf.length % this.packetSize === 0) {
      // A transfer that is an exact multiple of the packet size must be terminated with a ZLP.
      await this.device.nativeTransferOut(this.outEndpoint, timeoutMs, new Uint8Array(0));
    }
  }

  async receiveContainer(timeoutMs, onProgress) {
    await this.fill(HEADER_SIZE, timeoutMs);
    const length = this.queue.peek(4).readUInt32LE(0);
    if (length < HEADER_SIZE || length > MAX_CONTAINER) {
      this.queue.clear();
      throw new MtpError(`Invalid MTP container length ${length}; the USB stream is out of sync.`);
    }
    await this.fill(length, timeoutMs, onProgress ? (have) => onProgress(Math.min(have, length) - HEADER_SIZE, length - HEADER_SIZE) : null);
    return decodeContainer(this.queue.take(length));
  }

  async fill(n, timeoutMs, onProgress) {
    let emptyReads = 0;
    while (this.queue.length < n) {
      const missing = n - this.queue.length;
      const request = Math.min(MAX_READ, Math.ceil(missing / this.packetSize) * this.packetSize);
      const chunk = await this.read(request, timeoutMs);
      if (chunk.length === 0) {
        // Zero-length packet terminating the previous transfer: just read again.
        if (++emptyReads > 8) throw new MtpError("The Kindle keeps sending empty USB packets.");
        continue;
      }
      emptyReads = 0;
      this.queue.push(chunk);
      onProgress?.(this.queue.length);
    }
  }

  async read(length, timeoutMs) {
    let data;
    try {
      data = await this.device.nativeTransferIn(this.inEndpoint, timeoutMs, length);
    } catch (e) {
      throw new MtpError(`USB read failed: ${e?.message || e}`);
    }
    if (data == null) {
      await this.clearHalt("in");
      throw new MtpError("The Kindle stalled the USB transfer.");
    }
    return Buffer.from(data);
  }

  async clearHalt(direction) {
    try {
      await this.device.clearHalt(direction, direction === "in" ? this.inEndpoint : this.outEndpoint);
    } catch {
      // best effort
    }
  }
}
