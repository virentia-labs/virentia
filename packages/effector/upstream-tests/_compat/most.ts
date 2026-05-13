export function from(unit: any): any {
  return {
    observe(fn: (value: unknown) => void) {
      return unit.watch(fn);
    },
  };
}

export function periodic(): any {
  return {
    observe() {
      return () => {};
    },
  };
}
