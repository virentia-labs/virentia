import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const relayPathname = "/__virentia_devtools";
const websocketKeySuffix = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface RelayClient {
  buffer: Buffer;
  socket: Duplex;
  /** Reassembly buffer for a fragmented message (FIN=0 start + continuations). */
  fragments: Buffer[];
}

interface UpgradeServer {
  off(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void;
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void;
}

export function installVirentiaInspectorRelay(server: UpgradeServer): () => void {
  const clients = new Set<RelayClient>();
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);

    if (url.pathname !== relayPathname) {
      return;
    }

    const key = request.headers["sec-websocket-key"];

    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const client: RelayClient = {
      buffer: Buffer.alloc(0),
      socket,
      fragments: [],
    };

    clients.add(client);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createAcceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    socket.on("data", (chunk: Buffer) => {
      try {
        handleData(client, chunk, clients);
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));

    if (head.length) {
      handleData(client, head, clients);
    }
  };

  server.on("upgrade", onUpgrade);

  return () => {
    server.off("upgrade", onUpgrade);

    for (const client of clients) {
      client.socket.destroy();
    }

    clients.clear();
  };
}

function handleData(client: RelayClient, chunk: Buffer, clients: Set<RelayClient>): void {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length) {
    const frame = readFrame(client.buffer);

    if (!frame) {
      return;
    }

    client.buffer = frame.rest;

    if (frame.opcode === 0x8) {
      client.socket.end();
      return;
    }

    if (frame.opcode === 0x9) {
      writeFrame(client.socket, frame.payload, 0xa);
      continue;
    }

    // Browsers fragment large messages (Chrome: > ~128 KiB): the first frame
    // carries the data opcode with FIN=0, continuations use opcode 0x0, the
    // last one has FIN=1. Reassemble before broadcasting — dropping
    // continuations silently destroys every large payload.
    if (frame.opcode === 0x1) {
      if (frame.fin && client.fragments.length === 0) {
        broadcast(client, clients, frame.payload.toString("utf8"));
        continue;
      }

      client.fragments = [frame.payload];

      if (frame.fin) {
        // A lone FIN=1 start while a previous message never completed —
        // deliver it and reset.
        broadcast(client, clients, frame.payload.toString("utf8"));
        client.fragments = [];
      }

      continue;
    }

    if (frame.opcode === 0x0) {
      if (client.fragments.length === 0) {
        // Continuation without a start — protocol violation, skip.
        continue;
      }

      client.fragments.push(frame.payload);

      if (frame.fin) {
        const message = Buffer.concat(client.fragments).toString("utf8");
        client.fragments = [];
        broadcast(client, clients, message);
      }

      continue;
    }
  }
}

function broadcast(sender: RelayClient, clients: Set<RelayClient>, message: string): void {
  for (const client of clients) {
    if (client === sender) {
      continue;
    }

    writeFrame(client.socket, Buffer.from(message));
  }
}

function readFrame(buffer: Buffer): {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  rest: Buffer;
} | null {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  const fin = (buffer[0] & 0x80) === 0x80;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }

    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }

    const longLength = buffer.readBigUInt64BE(offset);

    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large");
    }

    length = Number(longLength);
    offset += 8;
  }

  const maskOffset = offset;

  if (masked) {
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const rawPayload = buffer.subarray(offset, offset + length);
  const payload = masked
    ? unmask(rawPayload, buffer.subarray(maskOffset, maskOffset + 4))
    : rawPayload;

  return {
    opcode,
    fin,
    payload,
    rest: buffer.subarray(offset + length),
  };
}

function writeFrame(socket: Duplex, payload: Buffer, opcode = 0x1): void {
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.allocUnsafe(payload.length);

  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index % 4];
  }

  return output;
}

function createAcceptKey(key: string): string {
  return createHash("sha1").update(`${key}${websocketKeySuffix}`).digest("base64");
}
