// One turn in a thread: home, or an issue. The thread's coordinator session
// and its live lines live in the store, so any device continues it. An issue
// turn also hands the coordinator the comments posted since its last turn,
// which is how pipeline and human comments flow back into the live view.
import { ORG } from './constants.ts';
import { type CoordinatorEvent, coordinate } from './coordinator.ts';
import { type IssueComment, LEFT_OUT, readThread } from './issue.ts';
import { HOME_THREAD, type Store, threadKey } from './store.ts';

export interface IssueRef {
  repo: string;
  number: number;
}

const MAX_COMMENT_CHARS = 4000;

/** What the coordinator hasn't seen yet on the issue, as plain text. */
export function framePrompt(
  prompt: string,
  ref: IssueRef | undefined,
  fresh: IssueComment[],
  first: boolean,
): string {
  if (!ref) return prompt;
  const parts: string[] = [];
  if (first)
    parts.push(
      `This is the thread for ${ORG}/${ref.repo}#${ref.number}. Read it before you answer.`,
    );
  if (fresh.length) {
    parts.push(
      'New comments on the issue since your last turn:',
      ...fresh.map(
        (c) =>
          `--- ${c.author} at ${c.at}\n${c.trusted ? c.body.slice(0, MAX_COMMENT_CHARS) : LEFT_OUT}`,
      ),
    );
  }
  return parts.length ? `${parts.join('\n\n')}\n\n--- Troy now says:\n${prompt}` : prompt;
}

export async function* chatTurn(
  store: Store,
  prompt: string,
  ref?: IssueRef,
  run: typeof coordinate = coordinate,
  read: typeof readThread = readThread,
): AsyncGenerator<CoordinatorEvent> {
  const key = ref ? threadKey(ref.repo, ref.number) : HOME_THREAD;
  const thread = await store.get(key);
  let fresh: IssueComment[] = [];
  if (ref) {
    const { comments } = await read(ref.repo, ref.number);
    fresh = comments.filter((c) => c.id > (thread.seen ?? 0));
  }
  await store.update(key, (t) => void t.lines.push({ role: 'me', text: prompt }));
  // Marked seen only once the coordinator has started, so a turn that fails
  // before it runs shows these comments again next time.
  const seen = fresh.length ? Math.max(...fresh.map((c) => c.id)) : thread.seen;
  for await (const event of run(
    framePrompt(prompt, ref, fresh, !thread.session),
    thread.session,
    !ref,
  )) {
    if (event.type === 'session')
      await store.update(key, (t) => {
        t.session = event.id;
        t.seen = seen;
      });
    else if (event.type === 'text')
      await store.update(key, (t) => void t.lines.push({ role: 'bot', text: event.text }));
    else if (event.type === 'tool')
      await store.update(key, (t) => void t.lines.push({ role: 'tool', text: event.name }));
    yield event;
  }
}
