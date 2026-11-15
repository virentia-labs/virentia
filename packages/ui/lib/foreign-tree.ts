import { foreignTree as describe } from "./builtin-descriptions";
import { withForeignRenderer } from "./foreign-renderer";

// A bridge retains its DOM handler together with its internal producer.
export const foreignTree: typeof describe = withForeignRenderer(describe);
