import { describe, expectTypeOf, it } from "vitest";
import type { AppMessage, WebSocketConstructorLike } from "../../lib/devtools";

describe("devtools types", () => {
  it("accepts a minimal fake WebSocket constructor", () => {
    class Minimal {
      readyState = 0;
      constructor(public url: string) {}
      send(_data: string): void {}
      close(): void {}
      addEventListener(_type: string, _listener: (event: { data?: unknown }) => void): void {}
    }

    expectTypeOf<typeof Minimal>().toMatchTypeOf<WebSocketConstructorLike>();
  });

  it("keeps the AppMessage union exhaustive across its variants", () => {
    // A discriminated union stays exhaustive.
    const classify = (message: AppMessage): string => {
      switch (message.type) {
        case "app":
          return message.appName;
        case "graph":
          return message.snapshot.nodes.length.toString();
        case "timeline":
          return message.event.id;
        case "trigger-result":
          return message.requestId;
        default: {
          const never: never = message;
          return never;
        }
      }
    };
    expectTypeOf(classify).parameter(0).toEqualTypeOf<AppMessage>();
  });
});
