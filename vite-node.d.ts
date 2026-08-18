/**
 * The Node APIs the Vite config needs, and only those.
 *
 * Declared here rather than pulling in @types/node: the config uses two
 * functions, and the full Node typings would otherwise leak globals into a
 * project whose source is browser-only.
 */
declare module "node:child_process" {
  export function execSync(
    command: string,
    options?: { encoding?: "utf8"; stdio?: unknown },
  ): string;
}

declare module "node:module" {
  export function createRequire(path: string | URL): (id: string) => unknown;
}
