/**
 * The one Node API the Vite config needs.
 *
 * Declared here rather than pulling in @types/node: the config uses a single
 * function, and the full Node typings would otherwise leak globals into a
 * project whose source is browser-only.
 */
declare module "node:child_process" {
  export function execSync(
    command: string,
    options?: { encoding?: "utf8"; stdio?: unknown },
  ): string;
}
