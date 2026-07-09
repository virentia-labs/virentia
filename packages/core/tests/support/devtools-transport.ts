import type {
  AppMessage,
  InspectorMessage,
  RelayTransport,
  WebSocketConstructorLike,
} from "../../lib/devtools";

export interface RecordingTransport extends RelayTransport {
  readonly sent: Array<{ message: AppMessage }>;
  deliver(message: unknown): void;
  listenerCount(): number;
}

export const recordingTransport = (): RecordingTransport => {
  const sent: Array<{ message: AppMessage }> = [];
  const listeners = new Set<(message: unknown) => void>();

  return {
    sent,
    dispose() {
      listeners.clear();
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(message) {
      sent.push(message as { message: AppMessage });
    },
    deliver(message) {
      for (const listener of [...listeners]) {
        listener(message);
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
};

export const messages = (transport: RecordingTransport): AppMessage[] =>
  transport.sent.map((envelope) => envelope.message);

export const messagesOfType = <T extends AppMessage["type"]>(
  transport: RecordingTransport,
  type: T,
): Array<Extract<AppMessage, { type: T }>> =>
  messages(transport).filter((message): message is Extract<AppMessage, { type: T }> => message.type === type);

let envIdCounter = 0;
export const inboundEnvelope = (
  channel: string,
  message: InspectorMessage,
  id?: string,
): Record<string, unknown> => ({
  __virentiaDevtools: true,
  id: id ?? `inbound-${envIdCounter++}`,
  channel,
  target: "app",
  message,
});

export class FakeSocket {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  handlers: Record<string, (event: { data?: unknown }) => void> = {};
  closeCalls = 0;

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3; // CLOSED
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.handlers[type] = listener;
  }

  fire(type: string, event: { data?: unknown } = {}): void {
    this.handlers[type]?.(event);
  }

  open(): void {
    this.readyState = 1; // OPEN
    this.fire("open");
  }
}

export const makeFakeCtor = (options: { throwTimes?: number } = {}) => {
  const instances: FakeSocket[] = [];
  const state = { constructs: 0, throwsLeft: options.throwTimes ?? 0 };
  const ctor = function (url: string) {
    state.constructs++;

    if (state.throwsLeft > 0) {
      state.throwsLeft--;
      throw new Error("ctor boom");
    }

    const socket = new FakeSocket(url);
    instances.push(socket);
    return socket;
  } as unknown as WebSocketConstructorLike;

  return { ctor, instances, state };
};
