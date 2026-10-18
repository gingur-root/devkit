import type { DashboardMessage } from '../stream.ts';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from './components/ai-elements/chain-of-thought.tsx';
import { Message, MessageContent, MessageResponse } from './components/ai-elements/message.tsx';

export function ChatMessage({ message, running }: { message: DashboardMessage; running: boolean }) {
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
            if (message.parts[i - 1]?.type === 'data-tool') return null;
            const names = [part.data.name];
            let end = i + 1;
            for (; end < message.parts.length; end++) {
              const next = message.parts[end];
              if (next?.type !== 'data-tool') break;
              names.push(next.data.name);
            }
            const active = running && end === message.parts.length;
            const shortNames = names.map((name) => name.replace('mcp__github__', ''));
            const label = active
              ? `Running ${shortNames.at(-1)}…`
              : `Used ${names.length} ${names.length === 1 ? 'tool' : 'tools'}`;
            return (
              <ChainOfThought key={i} className="min-w-0 space-y-0 text-xs text-muted-foreground">
                <ChainOfThoughtHeader
                  className="min-w-0 text-xs [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"
                  title={label}
                >
                  {label}
                </ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  {shortNames.map((name, step) => (
                    <ChainOfThoughtStep
                      key={step}
                      className="text-xs [overflow-wrap:anywhere]"
                      label={name}
                      status={active && step === names.length - 1 ? 'active' : 'complete'}
                    />
                  ))}
                </ChainOfThoughtContent>
              </ChainOfThought>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}
