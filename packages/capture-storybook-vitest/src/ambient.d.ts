declare module "vitest" {
  export const beforeEach: (fn: (context?: unknown) => unknown | Promise<unknown>) => void;
  export const afterEach: (fn: (context?: unknown) => unknown | Promise<unknown>) => void;
  export const expect: { getState?: () => Record<string, unknown> };
}

declare module "@vitest/browser/context" {
  export const page: unknown;
}
