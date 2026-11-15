/**
 * Hidden classes kept alive.
 *
 * V8 keeps the hidden class of an object only while some object has it, and
 * throws away every optimized function that checked it once it is gone.
 * Objects that die together (the rows of a list being cleared, the work of one
 * update) lose their classes at the next full GC, and the next burst of the
 * same work runs unoptimized until the engine optimizes it again. One inert
 * instance of each such class, built as the real ones are, keeps the class
 * alive, and the optimized code with it.
 *
 * They are held in a map a function fills: a module-level `const` that
 * nothing reads is dropped by tree shaking, its instance with it. Each module
 * keeps its instances under its own key, so a module evaluated again (hot
 * module replacement) replaces them, and the old module can be collected.
 */
const shapes = new Map<string, readonly object[]>();

/**
 * @internal Keeps the hidden classes of these inert instances alive (see
 * above), in place of what was kept under `key` before.
 */
export function retainShapes(key: string, ...instances: object[]): void {
  shapes.set(key, instances);
}
