import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { installVirentiaInspectorRelay } from "../../lib/server/relay";

/**
 * Browsers fragment WebSocket messages larger than ~128 KiB: the first frame
 * carries the opcode with FIN=0, continuations use opcode 0x0, the last one
 * has FIN=1. A relay that ignores FIN and drops continuation frames destroys
 * every large message — in practice, graph snapshots of real-world apps
 * (thousands of units) silently never reach the inspector UI.
 */

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
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];

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

/** Decode every text frame the relay wrote to a client socket. */
function decodeWritten(socket: FakeSocket): string[] {
  const messages: string[] = [];
  for (const chunk of socket.written) {
    let offset = 0;
    while (offset < chunk.length) {
      const opcode = chunk[offset] & 0x0f;
      let length = chunk[offset + 1] & 0x7f;
      let headerSize = 2;
      if (length === 126) {
        length = chunk.readUInt16BE(offset + 2);
        headerSize = 4;
      } else if (length === 127) {
        length = Number(chunk.readBigUInt64BE(offset + 2));
        headerSize = 10;
      }
      if (opcode === 0x1) {
        messages.push(chunk.subarray(offset + headerSize, offset + headerSize + length).toString("utf8"));
      }
      offset += headerSize + length;
    }
  }
  return messages;
}

function connectPair(): { sender: FakeSocket; receiver: FakeSocket } {
  const server = new EventEmitter() as unknown as Parameters<typeof installVirentiaInspectorRelay>[0] &
    EventEmitter;
  installVirentiaInspectorRelay(server);

  const open = (socket: FakeSocket) => {
    (server as EventEmitter).emit(
      "upgrade",
      { url: "/__virentia_devtools", headers: { host: "127.0.0.1", "sec-websocket-key": "x" } },
      socket as unknown as Duplex,
      Buffer.alloc(0),
    );
    socket.written.length = 0; // drop the 101 handshake
  };

  const sender = new FakeSocket();
  const receiver = new FakeSocket();
  open(sender);
  open(receiver);
  return { sender, receiver };
}

describe("relay: fragmented websocket messages", () => {
  it("reassembles a fragmented text message and broadcasts it whole", () => {
    const { sender, receiver } = connectPair();

    const message = JSON.stringify({ type: "graph", blob: "x".repeat(300_000) });
    const bytes = Buffer.from(message);
    const third = Math.floor(bytes.length / 3);

    sender.emit("data", maskedFrame(bytes.subarray(0, third), 0x1, false));
    sender.emit("data", maskedFrame(bytes.subarray(third, third * 2), 0x0, false));
    sender.emit("data", maskedFrame(bytes.subarray(third * 2), 0x0, true));

    const delivered = decodeWritten(receiver);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBe(message);
  });

  it("still delivers small single-frame messages", () => {
    const { sender, receiver } = connectPair();

    const message = '{"type":"app"}';
    sender.emit("data", maskedFrame(Buffer.from(message), 0x1, true));

    expect(decodeWritten(receiver)).toEqual([message]);
  });

  it("does not broadcast partial fragments before the final frame", () => {
    const { sender, receiver } = connectPair();

    sender.emit("data", maskedFrame(Buffer.from("part1"), 0x1, false));
    expect(decodeWritten(receiver)).toEqual([]);

    sender.emit("data", maskedFrame(Buffer.from("part2"), 0x0, true));
    expect(decodeWritten(receiver)).toEqual(["part1part2"]);
  });
});
