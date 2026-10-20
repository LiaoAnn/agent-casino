import type { HandRecord } from '@/components/hand';
import { Badge } from '@/components/ui/badge';
import { eventParts } from '@/lib/format';

// One step of a hand: street, who, action and amount (in gold). The watched
// agent's note follows in full, indented, when it sent one (match records
// never have notes).
export function ActionLogEntry({
  event,
  players,
  previousEvents,
}: {
  event: HandRecord['events'][number];
  players: readonly string[];
  previousEvents: HandRecord['events'];
}) {
  const { street, who, action, amount } = eventParts(
    event,
    players,
    previousEvents,
  );
  return (
    <li className="py-0.5 pl-1">
      <span className="text-mist">{street}</span>{' '}
      <span className="font-medium text-ivory">{who}</span>{' '}
      {event.type === 'fold' ? (
        <Badge variant="fold">{action}</Badge>
      ) : (
        <span className="text-ivory">{action}</span>
      )}
      {amount !== undefined && (
        <>
          {' '}
          <span className="font-semibold text-gold-400 tabular-nums">
            {amount}
          </span>
        </>
      )}
      {event.timeout && (
        <>
          {' '}
          <Badge variant="timeout">超時代打</Badge>
        </>
      )}
      {event.note !== undefined && (
        <blockquote className="mt-1 mb-2 max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-r-md border-gold-400 border-l-2 bg-navy-800 px-3 py-2 text-mist">
          {event.note}
        </blockquote>
      )}
    </li>
  );
}
