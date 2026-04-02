/** Create a Proxy that throws on any property access for unsupported VSCode APIs */
export function createNotSupported(namespace: string): unknown {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => `[vscode.${namespace} — not supported in PPM]`;
      }
      if (typeof prop === "symbol") return undefined;
      throw new Error(
        `vscode.${namespace}.${prop} is not supported in PPM. ` +
        `See https://github.com/hienlh/ppm/docs/extension-migration.md for alternatives.`,
      );
    },
  });
}
