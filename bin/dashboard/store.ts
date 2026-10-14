// The dashboard's own state: each thread's coordinator session, the last issue
// comment it has seen, and the live view's recent lines, so phone and desk see
// the same conversation. GitHub stays the record; losing this file loses only
// the live view's scrollback.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOME_THREAD = 'home';
const MAX_LINES = 200;

export interface Line {
  role: 'me' | 'bot' | 'tool';
  text: string;
}

export interface Thread {
  session?: string;
  /** The newest issue comment ID already shown to the coordinator. */
  seen?: number;
  lines: Line[];
}

export function threadKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function createStore(
  file = process.env.DASHBOARD_STATE ?? join(homedir(), '.local/state/devkit-dashboard/state.json'),
) {
  let threads: Record<string, Thread> | undefined;
  // One writer at a time, so two quick turns can't interleave a rename.
  let writing = Promise.resolve();
  // The first read is shared, so two requests right after a start can't each
  // build their own copy and drop the other's change.
  let loading: Promise<Record<string, Thread>> | undefined;

  async function read(): Promise<Record<string, Thread>> {
    try {
      threads = JSON.parse(await readFile(file, 'utf8')) as Record<string, Thread>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      threads = {};
    }
    return threads;
  }

  function load(): Promise<Record<string, Thread>> {
    loading ??= read().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  }

  function save(): Promise<void> {
    // A failed write must not block every later one.
    writing = writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, JSON.stringify(threads), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return writing;
  }

  return {
    async get(key: string): Promise<Thread> {
      return (await load())[key] ?? { lines: [] };
    },
    async update(key: string, change: (thread: Thread) => void): Promise<Thread> {
      const all = await load();
      const thread = (all[key] ??= { lines: [] });
      change(thread);
      thread.lines = thread.lines.slice(-MAX_LINES);
      await save();
      return thread;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
