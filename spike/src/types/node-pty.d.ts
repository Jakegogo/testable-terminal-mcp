/**
 * Minimal local type declaration for node-pty.
 *
 * node-pty 1.1.0 ships with `typings/node-pty.d.ts` but our tsconfig's
 * `moduleResolution: "bundler"` doesn't always pick it up via the package's
 * `types` field. Rather than fight resolution, we declare the surface we
 * actually use here. Round 9 review fix: previously `tsc --noEmit` failed.
 */

declare module "node-pty" {
  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string };
    encoding?: string | null;
    handleFlowControl?: boolean;
    flowControlPause?: string;
    flowControlResume?: string;
    useConpty?: boolean;
  }

  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    onData(callback: (data: string) => void): { dispose(): void };
    onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  }

  export function spawn(file: string, args: string[] | string, opts: IPtyForkOptions): IPty;
}
