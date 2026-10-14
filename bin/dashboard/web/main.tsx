// The dashboard page (devkit#91): useChat from the Vercel AI SDK for the
// conversation, Streamdown for markdown. The server keeps each thread's state;
// this page only draws it.
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';

import type { DashboardMessage } from '../stream.ts';
import './style.css';

interface Ref {
  repo: string;
  number: number;
}
interface ThreadItem extends Ref {
  title: string;
  url: string;
  labels: string[];
  line: string;
}
interface Issue extends Ref {
  title: string;
  url: string;
  line: string;
  comments: { id: number; author: string; body: string; at: string }[];
}

// The coordinator's links open directly. Issue comments can come from anyone,
// so their links keep Streamdown's confirm-before-opening step.
function Markdown({ children, trusted = true }: { children: string; trusted?: boolean }) {
  return <Streamdown linkSafety={{ enabled: !trusted }}>{children}</Streamdown>;
}

const HOME_HINT = 'Ask, queue, start, or follow up on an issue.';

function parseHash(): Ref | null {
  const [repo, number] = decodeURIComponent(location.hash.slice(1)).split('/');
  return repo && number ? { repo, number: Number(number) } : null;
}

function useHashRef(): Ref | null {
  const [ref, setRef] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRef(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return ref;
}

async function startPlan(t: Ref): Promise<boolean> {
  const response = await fetch('/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: t.repo, number: t.number }),
  });
  return response.ok;
}

function Threads({ current, version }: { current: Ref | null; version: number }) {
  const [list, setList] = useState<ThreadItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/api/threads')
      .then((r) => r.json() as Promise<ThreadItem[]>)
      .then(setList, () => setFailed(true));
  }, [version]);
  if (failed) return <p>Could not load threads.</p>;
  if (!list) return <p>Loading…</p>;
  return (
    <>
      {list.map((t) => (
        <a
          key={`${t.repo}#${t.number}`}
          href={`#${t.repo}/${t.number}`}
          className={current?.repo === t.repo && current.number === t.number ? 'here' : undefined}
        >
          {t.title}
          <small>
            {t.repo}#{t.number} · {t.line}
          </small>
          {/* Queued asks wait in Ask until the coordinator or this button starts them. */}
          {t.labels.includes('ready-for-agent') &&
            !t.labels.some((l) => l.startsWith('agent:')) && <StartButton thread={t} />}
        </a>
      ))}
    </>
  );
}

function StartButton({ thread }: { thread: Ref }) {
  const [state, setState] = useState<'idle' | 'busy' | 'Started' | 'Failed'>('idle');
  return (
    <button
      type="button"
      className="start"
      disabled={state !== 'idle'}
      onClick={async (e) => {
        e.preventDefault();
        setState('busy');
        setState((await startPlan(thread)) ? 'Started' : 'Failed');
      }}
    >
      {state === 'idle' || state === 'busy' ? 'Start' : state}
    </button>
  );
}

function Message({ message }: { message: DashboardMessage }) {
  return (
    <>
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return message.role === 'user' ? (
            <p key={i} className="msg me">
              {part.text}
            </p>
          ) : (
            <div key={i} className="msg bot">
              <Markdown>{part.text}</Markdown>
            </div>
          );
        }
        if (part.type === 'data-tool') {
          return (
            <p key={i} className="msg tool">
              · {part.data.name.replace('mcp__github__', '')}
            </p>
          );
        }
        return null;
      })}
    </>
  );
}

function Chat({
  thread,
  initial,
  pending,
  onRoute,
  onTurnEnd,
  onPendingSent,
  prelude,
}: {
  onPendingSent: () => void;
  prelude?: ReactNode;
  thread: Ref | null;
  initial: DashboardMessage[];
  pending: string | null;
  onRoute: (to: Ref, text: string) => void;
  onTurnEnd: () => void;
}) {
  const [input, setInput] = useState('');
  // What Troy last sent, re-asked in the issue's thread if home routes it.
  const lastSent = useRef('');
  const route = useRef<Ref | null>(null);
  const send = (text: string) => {
    lastSent.current = text;
    void sendMessage({ text });
  };
  const transport = useMemo(
    () =>
      new DefaultChatTransport<DashboardMessage>({
        api: '/api/chat',
        // The server keeps the history; it needs only the new text and the thread.
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages.at(-1);
          const text = last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
          return { body: { text, ...thread } };
        },
      }),
    [thread],
  );
  const { messages, sendMessage, status, error } = useChat<DashboardMessage>({
    id: thread ? `${thread.repo}#${thread.number}` : 'home',
    messages: initial,
    transport,
    onData: (part) => {
      if (part.type === 'data-route' && !thread) route.current = part.data;
    },
    onFinish: () => {
      // A follow-up from home goes to its issue's thread once home's turn ends.
      const to = route.current;
      route.current = null;
      if (to) onRoute(to, lastSent.current);
      onTurnEnd();
    },
  });

  useEffect(() => {
    if (!pending) return;
    send(pending);
    onPendingSent();
    // Sent once, when the routed thread opens.
  }, [pending]);

  useEffect(() => {
    document.getElementById('log')?.scrollTo(0, 1e9);
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';
  return (
    <>
      <div id="log" aria-live="polite">
        {prelude}
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {busy && <p className="msg tool">· working…</p>}
        {error && <p className="msg tool">Error: {error.message}</p>}
      </div>
      <form
        id="ask"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          setInput('');
          send(text);
        }}
      >
        <textarea
          rows={2}
          placeholder="Message the coordinator"
          aria-label="Prompt"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button disabled={busy}>Send</button>
      </form>
    </>
  );
}

function App() {
  const ref = useHashRef();
  const key = ref ? `${ref.repo}#${ref.number}` : 'home';
  // Each response carries the thread it was for, so a slow load can't show in another.
  const [loaded, setLoaded] = useState<{
    key: string;
    issue: Issue | null;
    messages: DashboardMessage[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  // A routed message waits here, tagged with its thread, until that thread's chat sends it.
  const [pending, setPending] = useState<{ key: string; text: string } | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(false);
    // A routed message is only ever sent in the thread it was routed to, now.
    setPending((p) => (p?.key === key ? p : null));
    document.body.classList.remove('open');
    const query = ref ? `?repo=${encodeURIComponent(ref.repo)}&number=${ref.number}` : '';
    fetch(`/api/thread${query}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(
        (data: { issue: Issue | null; messages: DashboardMessage[] }) =>
          setLoaded({ key, ...data }),
        () => {
          // A late failure from a thread already left must not touch this one.
          if (!live) return;
          setFailed(true);
          setPending(null);
        },
      );
    return () => {
      live = false;
    };
  }, [ref?.repo, ref?.number]);

  const ready = loaded?.key === key ? loaded : null;
  const issue = ready?.issue;
  return (
    <>
      <aside>
        <a href="#">Home</a>
        <h2>Threads</h2>
        <Threads current={ref} version={version} />
      </aside>
      <main>
        <button id="menu" type="button" onClick={() => document.body.classList.toggle('open')}>
          ☰ Threads
        </button>
        <header>
          <h1>
            {issue ? (
              <>
                <a href={issue.url} target="_blank" rel="noreferrer">
                  {issue.repo}#{issue.number}
                </a>{' '}
                {issue.title}
              </>
            ) : ref ? (
              `${ref.repo}#${ref.number}`
            ) : (
              'Home'
            )}
          </h1>
          <div id="status">
            {failed
              ? 'Could not load this thread.'
              : !ready
                ? 'Loading…'
                : (issue?.line ?? HOME_HINT)}
          </div>
        </header>
        {ready && (
          <Chat
            key={key}
            thread={ref}
            initial={ready.messages}
            prelude={
              issue && (
                <>
                  {issue.comments.slice(-10).map((c) => (
                    <details key={c.id} className="comment">
                      <summary>
                        {c.author} · {new Date(c.at).toLocaleString()} ·{' '}
                        {c.body
                          .split('\n')
                          .find((l) => l.trim())
                          ?.slice(0, 80)}
                      </summary>
                      <Markdown trusted={false}>{c.body}</Markdown>
                    </details>
                  ))}
                </>
              )
            }
            pending={pending?.key === key ? pending.text : null}
            onPendingSent={() => setPending(null)}
            onRoute={(to, text) => {
              setPending({ key: `${to.repo}#${to.number}`, text });
              location.hash = `${to.repo}/${to.number}`;
            }}
            onTurnEnd={refresh}
          />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
