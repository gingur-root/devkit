// The dashboard page (devkit#91, #101, #98): the board is home, with the
// coordinator's chat beside it; an issue opens as its own thread. useChat from
// the Vercel AI SDK runs the conversation, drawn with AI Elements. The server
// keeps each thread's state; this page only draws it.
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { cn } from 'cn';
import { ChevronDown, ChevronUp, ChevronsUp, Equal, type LucideIcon } from 'lucide-react';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';

import { type Priority, READY_LABEL, STAGE_LABELS, STATUSES } from '../../agent/constants.ts';
import type { BoardCard } from '../board.ts';
import { BOARD_EVENT } from '../constants.ts';
import type { BoardEvent } from '../events.ts';
import type { DashboardMessage } from '../stream.ts';
import { CardButtons } from './card-buttons.tsx';
import { ChatMessage } from './chat-message.tsx';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './components/ai-elements/conversation.tsx';
import { MessageResponse } from './components/ai-elements/message.tsx';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from './components/ai-elements/prompt-input.tsx';
import { Badge } from './components/ui/badge.tsx';
import { Button } from './components/ui/button.tsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card.tsx';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './components/ui/sheet.tsx';
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

// React Flow is heavy, so the map loads only when opened.
const MapView = lazy(() => import('./map.tsx'));
const MAP_HASH = '#map';

const HOME_HINT = 'Ask, queue, start, or follow up on an issue.';
// Below this width the chat is a sheet over the board, not a panel beside it.
const WIDE = '(min-width: 1024px)';

const PRIORITY_ICONS: Record<Priority, { icon: LucideIcon; className: string }> = {
  P0: { icon: ChevronsUp, className: 'text-red-600 dark:text-red-400' },
  P1: { icon: ChevronUp, className: 'text-orange-500 dark:text-orange-400' },
  P2: { icon: Equal, className: 'text-amber-500 dark:text-amber-400' },
  P3: { icon: ChevronDown, className: 'text-blue-500 dark:text-blue-400' },
};

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => matchMedia(WIDE).matches,
  );
}

/** A queued ask: waiting in Ask until the coordinator or Start begins its plan. */
function queued(labels: string[]): boolean {
  return (
    labels.includes(READY_LABEL) &&
    !labels.some((l) => Object.values<string>(STAGE_LABELS).includes(l))
  );
}

function parseHash(hash: string): Ref | null {
  const [repo, number] = decodeURIComponent(hash.slice(1)).split('/');
  return repo && number ? { repo, number: Number(number) } : null;
}

function useHash(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => location.hash,
  );
}

// One stream for the page's life; the browser reconnects it on its own.
const boardEvents = new EventSource('/api/events');

/**
 * Calls `on` with the live updates the server sends. Deliveries can land in
 * bursts, so events that arrive together come as one batch and cost one refetch.
 */
function useBoardEvents(on: (events: BoardEvent[]) => void) {
  useEffect(() => {
    let batch: BoardEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (message: MessageEvent<string>) => {
      batch.push(JSON.parse(message.data) as BoardEvent);
      timer ??= setTimeout(() => {
        const events = batch;
        batch = [];
        timer = undefined;
        on(events);
      }, 200);
    };
    boardEvents.addEventListener('message', listener);
    return () => {
      clearTimeout(timer);
      boardEvents.removeEventListener('message', listener);
    };
  }, [on]);
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
          {queued(t.labels) && <StartButton thread={t} />}
        </a>
      ))}
    </>
  );
}

function StartButton({ thread, className }: { thread: Ref; className?: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'Started' | 'Failed'>('idle');
  return (
    <Button
      size="xs"
      className={cn('mt-1', className)}
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

function PriorityIcon({ priority }: { priority: Priority }) {
  const { icon: Icon, className } = PRIORITY_ICONS[priority];
  return (
    <span
      title={`Priority ${priority}`}
      className="relative mr-1 inline-flex items-center gap-0.5 align-middle"
    >
      <Icon aria-hidden className={cn('size-3.5', className)} />
      {priority}
    </span>
  );
}

function BoardCardView({ card, onChange }: { card: BoardCard; onChange: () => void }) {
  const running = card.labels.find((l) => Object.values<string>(STAGE_LABELS).includes(l));
  return (
    <Card
      className={cn(
        'relative gap-2 py-3',
        card.column === 'Needs you' &&
          'border-amber-500 bg-amber-50 ring-1 ring-amber-500 dark:bg-amber-950/40',
      )}
    >
      <CardHeader className="px-3">
        <CardTitle className="text-sm leading-snug break-words">
          {/* The whole card opens the thread; chips and buttons sit above this link. */}
          <a href={`#${card.repo}/${card.number}`} className="after:absolute after:inset-0">
            {card.title}
          </a>
        </CardTitle>
        <CardDescription className="text-xs">
          {card.priority && (
            <a href={`#${card.repo}/${card.number}`}>
              <PriorityIcon priority={card.priority} />
            </a>
          )}
          {card.repo}#{card.number}
          {running && ` · ${running} running`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-3">
        {card.subtasks.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {card.subtasks.map((s) => (
              <Badge
                key={`${s.repo}#${s.number}`}
                asChild
                variant="outline"
                className={cn(
                  'relative',
                  s.column === 'Needs you' && 'border-amber-500 text-amber-700 dark:text-amber-400',
                )}
              >
                <a href={`#${s.repo}/${s.number}`} title={s.title}>
                  {s.repo !== card.repo && s.repo}#{s.number} {s.column}
                </a>
              </Badge>
            ))}
          </div>
        )}
        <CardButtons card={card} onDone={onChange} />
      </CardContent>
    </Card>
  );
}

function Board({ version }: { version: number }) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  // A button press reloads the board at once, without waiting for a live update.
  const [pressed, setPressed] = useState(0);
  const reload = useCallback(() => setPressed((n) => n + 1), []);
  useEffect(() => {
    setFailed(false);
    fetch('/api/board')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<BoardCard[]>;
      })
      .then(setCards, () => setFailed(true));
  }, [version, pressed]);
  if (failed) return <p className="p-4">Could not load the board.</p>;
  if (!cards) return <p className="p-4 text-muted-foreground">Loading…</p>;
  return (
    // A phone stacks the columns; wider screens lay them side by side and scroll the row.
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:flex-row md:gap-4 md:overflow-x-auto">
      {STATUSES.map((column) => {
        const list = cards.filter((c) => c.column === column);
        return (
          <section key={column} className="flex flex-col gap-2 md:w-56 md:shrink-0">
            <h2
              className={cn(
                'text-xs font-medium text-muted-foreground uppercase',
                column === 'Needs you' && list.length > 0 && 'text-amber-700 dark:text-amber-400',
              )}
            >
              {column} · {list.length}
            </h2>
            {list.map((card) => (
              <BoardCardView key={`${card.repo}#${card.number}`} card={card} onChange={reload} />
            ))}
          </section>
        );
      })}
    </div>
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

interface Loaded {
  key: string;
  issue: Issue | null;
  messages: DashboardMessage[];
}

/** A thread's issue and chat history, from the server's store. */
function useThread(ref: Ref | null, version = 0) {
  const key = ref ? `${ref.repo}#${ref.number}` : 'home';
  // Each response carries the thread it was for, so a slow load can't show in another.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  // A reload of the same thread keeps it on screen, so a running chat is not torn down.
  useEffect(() => setLoaded(null), [key]);
  useEffect(() => {
    let live = true;
    setFailed(false);
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
          if (live) setFailed(true);
        },
      );
    return () => {
      live = false;
    };
  }, [ref?.repo, ref?.number, version]);
  return { key, ready: loaded?.key === key ? loaded : null, failed };
}

type Route = (to: Ref, text: string) => void;

function HomeChat({ onRoute, onTurnEnd }: { onRoute: Route; onTurnEnd: () => void }) {
  // Loaded on mount, so a sheet reopened after a turn shows that turn.
  const { ready, failed } = useThread(null);
  if (failed) return <p className="p-4">Could not load the chat.</p>;
  if (!ready) return <p className="p-4 text-muted-foreground">Loading…</p>;
  return (
    <Chat
      thread={null}
      initial={ready.messages}
      prelude={<p className="text-sm text-muted-foreground">{HOME_HINT}</p>}
      pending={null}
      onPendingSent={() => {}}
      onRoute={onRoute}
      onTurnEnd={onTurnEnd}
    />
  );
}

function Home({ onRoute }: { onRoute: Route }) {
  const wide = useWide();
  const [version, setVersion] = useState(0);
  // A coordinator turn may have moved cards.
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useBoardEvents(refresh);
  const chat = <HomeChat onRoute={onRoute} onTurnEnd={refresh} />;
  return (
    <div className="flex h-dvh lg:grid lg:grid-cols-[1fr_24rem]">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-4">
            <h1 className="font-semibold">Board</h1>
            <a href={MAP_HASH} className="text-muted-foreground">
              Map
            </a>
          </div>
          {!wide && (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm">
                  Chat
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full gap-0 sm:max-w-md" aria-describedby={undefined}>
                <SheetTitle className="border-b px-4 py-3">Coordinator</SheetTitle>
                {chat}
              </SheetContent>
            </Sheet>
          )}
        </header>
        <Board version={version} />
      </main>
      {wide && (
        <aside className="flex min-h-0 flex-col overflow-hidden border-l">
          <h2 className="border-b px-4 py-3 font-semibold">Coordinator</h2>
          {chat}
        </aside>
      )}
    </div>
  );
}

function IssueView({
  thread,
  pending,
  setPending,
  onRoute,
}: {
  thread: Ref;
  pending: { key: string; text: string } | null;
  setPending: (p: null) => void;
  onRoute: Route;
}) {
  const [reloads, setReloads] = useState(0);
  const { key, ready, failed } = useThread(thread, reloads);
  const [version, setVersion] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useBoardEvents(
    useCallback(
      (events) => {
        refresh();
        const mine = (e: BoardEvent) =>
          e.type === BOARD_EVENT.cardChanged &&
          e.repo === thread.repo &&
          e.number === thread.number;
        if (events.some(mine)) setReloads((r) => r + 1);
      },
      [refresh, thread.repo, thread.number],
    ),
  );

  useEffect(() => setDrawer(false), [key]);
  useEffect(() => {
    if (failed) setPending(null);
  }, [failed]);

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
          Board
        </a>
        <h2 className="mt-4 mb-2 text-xs text-muted-foreground uppercase">Threads</h2>
        <Threads current={thread} version={version} />
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
            ) : (
              `${thread.repo}#${thread.number}`
            )}
          </h1>
          <div id="status" className="text-sm text-muted-foreground">
            {failed ? 'Could not load this thread.' : !ready ? 'Loading…' : issue?.line}
          </div>
        </header>
        {ready && (
          <Chat
            key={key}
            thread={thread}
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
            onRoute={onRoute}
            onTurnEnd={refresh}
          />
        )}
      </main>
    </div>
  );
}

function App() {
  const hash = useHash();
  const ref = useMemo(() => parseHash(hash), [hash]);
  const key = ref ? `${ref.repo}#${ref.number}` : 'home';
  // A routed message waits here, tagged with its thread, until that thread's chat sends it.
  const [pending, setPending] = useState<{ key: string; text: string } | null>(null);
  // A routed message is only ever sent in the thread it was routed to, now.
  useEffect(() => setPending((p) => (p?.key === key ? p : null)), [key]);
  const onRoute = useCallback<Route>((to, text) => {
    setPending({ key: `${to.repo}#${to.number}`, text });
    location.hash = `${to.repo}/${to.number}`;
  }, []);
  if (hash === MAP_HASH) {
    return (
      <Suspense fallback={<p className="p-4 text-muted-foreground">Loading…</p>}>
        <MapView />
      </Suspense>
    );
  }
  return ref ? (
    <IssueView thread={ref} pending={pending} setPending={setPending} onRoute={onRoute} />
  ) : (
    <Home onRoute={onRoute} />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
