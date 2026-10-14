// The dashboard page (devkit#91, #101): useChat from the Vercel AI SDK for the
// conversation, drawn with AI Elements. The server keeps each thread's state;
// this page only draws it.
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { cn } from 'cn';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { DashboardMessage } from '../stream.ts';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './components/ai-elements/conversation.tsx';
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message.tsx';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from './components/ai-elements/prompt-input.tsx';
import { Tool, ToolHeader } from './components/ai-elements/tool.tsx';
import { Button } from './components/ui/button.tsx';
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
  if (!list) return <p className="text-muted-foreground">Loading…</p>;
  return (
    <>
      {list.map((t) => (
        <a
          key={`${t.repo}#${t.number}`}
          href={`#${t.repo}/${t.number}`}
          className={cn(
            'block border-b py-2',
            current?.repo === t.repo && current.number === t.number && 'font-semibold',
          )}
        >
          {t.title}
          <small className="block text-muted-foreground">
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
    <Button
      size="xs"
      className="mt-1"
      disabled={state !== 'idle'}
      onClick={async (e) => {
        e.preventDefault();
        setState('busy');
        setState((await startPlan(thread)) ? 'Started' : 'Failed');
      }}
    >
      {state === 'idle' || state === 'busy' ? 'Start' : state}
    </Button>
  );
}

function ChatMessage({ message, running }: { message: DashboardMessage; running: boolean }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return message.role === 'user' ? (
              <p key={i} className="whitespace-pre-wrap">
                {part.text}
              </p>
            ) : (
              // The coordinator's links open directly.
              <MessageResponse key={i} linkSafety={{ enabled: false }}>
                {part.text}
              </MessageResponse>
            );
          }
          if (part.type === 'data-tool') {
            return (
              <Tool key={i} className="mb-0">
                {/* Only the name is streamed, so there is nothing to expand. */}
                <ToolHeader
                  className="p-2 [&>svg:last-child]:hidden"
                  type="dynamic-tool"
                  toolName={part.data.name}
                  title={part.data.name.replace('mcp__github__', '')}
                  state={
                    running && i === message.parts.length - 1
                      ? 'input-available'
                      : 'output-available'
                  }
                />
              </Tool>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
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
  const { messages, sendMessage, status, error, stop } = useChat<DashboardMessage>({
    id: thread ? `${thread.repo}#${thread.number}` : 'home',
    messages: initial,
    transport,
    onData: (part) => {
      if (part.type === 'data-route' && !thread) route.current = part.data;
    },
    onFinish: ({ isAbort }) => {
      // A follow-up from home goes to its issue's thread once home's turn ends,
      // unless Troy stopped the turn.
      const to = route.current;
      route.current = null;
      if (to && !isAbort) onRoute(to, lastSent.current);
      onTurnEnd();
    },
  });

  useEffect(() => {
    if (!pending) return;
    send(pending);
    onPendingSent();
    // Sent once, when the routed thread opens.
  }, [pending]);

  const busy = status === 'submitted' || status === 'streaming';
  return (
    <>
      <Conversation className="min-h-0">
        <ConversationContent className="mx-auto max-w-3xl gap-4">
          {prelude}
          {messages.map((m, i) => (
            <ChatMessage key={m.id} message={m} running={busy && i === messages.length - 1} />
          ))}
          {status === 'submitted' && <p className="text-sm text-muted-foreground">Working…</p>}
          {error && <p className="text-sm text-destructive">Error: {error.message}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <PromptInput
        className="mx-auto max-w-3xl p-3"
        onSubmit={({ text }) => {
          if (text.trim()) send(text.trim());
        }}
      >
        <PromptInputTextarea
          className="min-h-12"
          placeholder="Message the coordinator"
          aria-label="Prompt"
          onKeyDown={(e) => {
            // Enter while a turn runs would clear the box without sending.
            if (busy && e.key === 'Enter' && !e.shiftKey) e.preventDefault();
          }}
        />
        <PromptInputFooter className="justify-end">
          <PromptInputSubmit status={status} onStop={stop} />
        </PromptInputFooter>
      </PromptInput>
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
  const [drawer, setDrawer] = useState(false);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(false);
    // A routed message is only ever sent in the thread it was routed to, now.
    setPending((p) => (p?.key === key ? p : null));
    setDrawer(false);
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
    <div className="grid h-dvh md:grid-cols-[18rem_1fr]">
      <aside
        className={cn(
          'overflow-y-auto border-r bg-background p-4',
          // On a phone the threads are a drawer, under the menu button that closes it.
          drawer ? 'fixed inset-y-0 left-0 right-1/5 z-10 pt-14' : 'hidden',
          'md:static md:block md:pt-4',
        )}
      >
        <a href="#" className="font-medium">
          Home
        </a>
        <h2 className="mt-4 mb-2 text-xs text-muted-foreground uppercase">Threads</h2>
        <Threads current={ref} version={version} />
      </aside>
      <main className="flex min-w-0 flex-col overflow-hidden">
        <Button
          variant="ghost"
          className="relative z-20 self-start md:hidden"
          onClick={() => setDrawer((open) => !open)}
        >
          ☰ Threads
        </Button>
        <header className="border-b px-4 py-3">
          <h1 className="font-semibold break-words">
            {issue ? (
              <>
                <a href={issue.url} target="_blank" rel="noreferrer" className="underline">
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
          <div id="status" className="text-sm text-muted-foreground">
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
            prelude={issue?.comments.slice(-10).map((c) => (
              <details key={c.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {c.author} · {new Date(c.at).toLocaleString()} ·{' '}
                  {c.body
                    .split('\n')
                    .find((l) => l.trim())
                    ?.slice(0, 80)}
                </summary>
                {/* Comments can come from anyone, so their links ask before opening. */}
                <MessageResponse className="mt-2" linkSafety={{ enabled: true }}>
                  {c.body}
                </MessageResponse>
              </details>
            ))}
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
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
