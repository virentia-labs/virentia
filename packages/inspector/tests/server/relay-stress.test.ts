import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { installVirentiaInspectorRelay } from "../../lib/server/relay";

// Beyond the basic fragmentation contract: the shapes a real browser and a real
// app actually produce — multi-megabyte graph snapshots, multi-byte characters
// landing across a frame boundary, control frames interleaved with data, and two
// apps fragmenting at the same time.

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }
  end(): void {}
  destroy(): void {}
}

function maskedFrame(payload: Buffer, opcode: number, fin: boolean): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, mask, masked]);
}

function decodeWritten(socket: FakeSocket): string[] {
  const messages: string[] = [];
  for (const chunk of socket.written) {
    let offset = 0;
    while (offset < chunk.length) {
      const opcode = chunk[offset]! & 0x0f;
      let length = chunk[offset + 1]! & 0x7f;
      let headerSize = 2;
      if (length === 126) {
        length = chunk.readUInt16BE(offset + 2);
        headerSize = 4;
      } else if (length === 127) {
        length = Number(chunk.readBigUInt64BE(offset + 2));
        headerSize = 10;
      }
      if (opcode === 0x1) {
        messages.push(
          chunk.subarray(offset + headerSize, offset + headerSize + length).toString("utf8"),
        );
      }
      offset += headerSize + length;
    }
  }
  return messages;
}

function connectMany(count: number): FakeSocket[] {
  const server = new EventEmitter() as unknown as Parameters<
    typeof installVirentiaInspectorRelay
  >[0] &
    EventEmitter;
  installVirentiaInspectorRelay(server);

  const sockets: FakeSocket[] = [];

  for (let i = 0; i < count; i += 1) {
    const socket = new FakeSocket();

    (server as EventEmitter).emit(
      "upgrade",
      { url: "/__virentia_devtools", headers: { host: "127.0.0.1", "sec-websocket-key": "x" } },
      socket as unknown as Duplex,
      Buffer.alloc(0),
    );
    socket.written.length = 0;
    sockets.push(socket);
  }

  return sockets;
}

describe("relay under realistic load", () => {
  it("reassembles a multi-byte character split across a frame boundary", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const message = JSON.stringify({ name: "счётчик 🎯 модель" });
    const bytes = Buffer.from(message, "utf8");
    // Cut in the middle of the emoji's 4-byte sequence.
    const emojiStart = bytes.indexOf(Buffer.from("🎯", "utf8"));
    const cut = emojiStart + 2;

    sender.emit("data", maskedFrame(bytes.subarray(0, cut), 0x1, false));
    sender.emit("data", maskedFrame(bytes.subarray(cut), 0x0, true));

    expect(decodeWritten(receiver)).toEqual([message]);
  });

  it("carries a multi-megabyte snapshot across many fragments", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const payload = JSON.stringify({
      kind: "graph",
      nodes: Array.from({ length: 60000 }, (_, i) => ({ id: `node:${i}`, name: `unit ${i}`, type: "store" })),
    });
    const bytes = Buffer.from(payload, "utf8");
    const chunkSize = 64 * 1024;

    expect(bytes.length).toBeGreaterThan(1_000_000);

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, offset + chunkSize);
      const isFirst = offset === 0;
      const isLast = offset + chunkSize >= bytes.length;

      sender.emit("data", maskedFrame(slice, isFirst ? 0x1 : 0x0, isLast));
    }

    expect(decodeWritten(receiver)).toEqual([payload]);
  });

  it("keeps reassembly per-client when two apps fragment at once", () => {
    const [a, b, receiver] = connectMany(3) as [FakeSocket, FakeSocket, FakeSocket];
    const first = JSON.stringify({ from: "a", body: "x".repeat(300) });
    const second = JSON.stringify({ from: "b", body: "y".repeat(300) });
    const firstBytes = Buffer.from(first);
    const secondBytes = Buffer.from(second);

    // Interleave the two conversations frame by frame.
    a.emit("data", maskedFrame(firstBytes.subarray(0, 100), 0x1, false));
    b.emit("data", maskedFrame(secondBytes.subarray(0, 100), 0x1, false));
    a.emit("data", maskedFrame(firstBytes.subarray(100), 0x0, true));
    b.emit("data", maskedFrame(secondBytes.subarray(100), 0x0, true));

    expect(decodeWritten(receiver).sort()).toEqual([first, second].sort());
  });

  it("survives a ping arriving between two data fragments", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const message = JSON.stringify({ kind: "timeline", body: "z".repeat(500) });
    const bytes = Buffer.from(message);

    sender.emit("data", maskedFrame(bytes.subarray(0, 200), 0x1, false));
    sender.emit("data", maskedFrame(Buffer.from("hb"), 0x9, true));
    sender.emit("data", maskedFrame(bytes.subarray(200), 0x0, true));

    expect(decodeWritten(receiver)).toEqual([message]);
  });

  it("handles a frame arriving split across TCP chunks", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const message = JSON.stringify({ kind: "graph", body: "q".repeat(1000) });
    const frame = maskedFrame(Buffer.from(message), 0x1, true);

    // The socket hands over arbitrary byte boundaries, not frame boundaries.
    for (let offset = 0; offset < frame.length; offset += 7) {
      sender.emit("data", frame.subarray(offset, offset + 7));
    }

    expect(decodeWritten(receiver)).toEqual([message]);
  });

  it("delivers a burst of whole messages in order", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const messages = Array.from({ length: 200 }, (_, i) => JSON.stringify({ seq: i }));

    for (const message of messages) {
      sender.emit("data", maskedFrame(Buffer.from(message), 0x1, true));
    }

    expect(decodeWritten(receiver)).toEqual(messages);
  });

  it("recovers after a continuation frame with no start", () => {
    const [sender, receiver] = connectMany(2) as [FakeSocket, FakeSocket];
    const message = JSON.stringify({ ok: true });

    sender.emit("data", maskedFrame(Buffer.from("orphan"), 0x0, true));
    sender.emit("data", maskedFrame(Buffer.from(message), 0x1, true));

    expect(decodeWritten(receiver)).toEqual([message]);
  });
});
