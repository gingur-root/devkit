// A card's buttons (devkit#99): only the moves its column allows, from
// buttons.ts. The server re-checks each press and answers 409 when the card
// changed since the page loaded; the board then reloads.
import { useState } from 'react';

import type { BoardCard } from '../board.ts';
import { buttons, type CardAction } from '../buttons.ts';
import { Button } from './components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx';
import { Textarea } from './components/ui/textarea.tsx';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip.tsx';

const LABELS: Record<CardAction, string> = {
  plan: 'Plan',
  close: 'Close',
  stop: 'Stop',
  continue: 'Continue',
  merge: 'Merge',
  'request-changes': 'Request changes',
  reopen: 'Reopen',
};

const MERGE_HINT = 'needs the merge token';

export function CardButtons({ card, onDone }: { card: BoardCard; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'continue' | 'request-changes' | null>(null);

  async function press(action: CardAction, extra: { note?: string; elevated?: boolean } = {}) {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/card', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: card.repo,
        number: card.number,
        action,
        seen: card.state,
        ...extra,
      }),
    }).catch(() => null);
    setBusy(false);
    if (response?.ok || response?.status === 409) {
      setDialog(null);
      if (response.status === 409) setError(await response.text());
      onDone();
      return;
    }
    setError(response ? await response.text() : 'Network error.');
  }

  return (
    // Above the card's full-size link, so a tap here presses the button.
    <div className="relative flex flex-wrap items-center gap-1">
      {buttons(card.state).map((action) =>
        action === 'merge' ? (
          <TooltipProvider key={action}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
                <span tabIndex={0} aria-label={`Merge: ${MERGE_HINT}`}>
                  <Button size="xs" variant="outline" disabled>
                    Merge
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{MERGE_HINT}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            key={action}
            size="xs"
            variant={action === 'close' || action === 'stop' ? 'outline' : 'default'}
            disabled={busy}
            onClick={() =>
              action === 'continue' || action === 'request-changes'
                ? setDialog(action)
                : void press(action)
            }
          >
            {LABELS[action]}
          </Button>
        ),
      )}
      {error && <small className="basis-full text-destructive">{error}</small>}
      {dialog && (
        <NoteDialog
          key={dialog}
          action={dialog}
          busy={busy}
          onClose={() => setDialog(null)}
          onSend={(note, elevated) => press(dialog, { note, elevated })}
        />
      )}
    </div>
  );
}

function NoteDialog({
  action,
  busy,
  onClose,
  onSend,
}: {
  action: 'continue' | 'request-changes';
  busy: boolean;
  onClose: () => void;
  onSend: (note: string, elevated: boolean) => void;
}) {
  const [note, setNote] = useState('');
  const [elevated, setElevated] = useState(false);
  // Elevate runs with Troy's own admin access, so it always takes a second step.
  const [confirming, setConfirming] = useState(false);
  const isContinue = action === 'continue';
  const ready = isContinue || note.trim().length > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {confirming ? 'Run elevated?' : isContinue ? 'Continue' : 'Request changes'}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? 'The build runs on the WSL desk with your own admin access. It waits while the desk is off.'
              : isContinue
                ? 'Approves the build. The planner reads your note, updates the plan if needed, then builds or asks again.'
                : 'The planner reads your note, re-plans, then builds again.'}
          </DialogDescription>
        </DialogHeader>
        {!confirming && (
          <>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isContinue ? 'Note for the planner (optional)' : 'What to change'}
              aria-label="Note"
            />
            {isContinue && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={elevated}
                  onChange={(e) => setElevated(e.target.checked)}
                />
                Elevate: build on the WSL desk
              </label>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={confirming ? () => setConfirming(false) : onClose}>
            {confirming ? 'Back' : 'Cancel'}
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => (elevated && !confirming ? setConfirming(true) : onSend(note, elevated))}
          >
            {confirming ? 'Run elevated' : isContinue ? 'Continue' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
