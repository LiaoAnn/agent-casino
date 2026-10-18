import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import type { HandRecord } from '@/components/hand';
import { Badge } from '@/components/ui/badge';
import { eventLabel } from '@/lib/format';

// One step of a hand, with the watched agent's note in full below it when
// it sent one (match records never have notes).
export function ActionLogEntry({
  event,
  players,
}: {
  event: HandRecord['events'][number];
  players: MatchDetail['players'];
}) {
  return (
    <li>
      {eventLabel(event, players)}
      {event.timeout && (
        <>
          {' '}
          <Badge>超時代打</Badge>
        </>
      )}
      {event.note !== undefined && (
        <blockquote className="mt-1 mb-2 whitespace-pre-wrap border-l-2 pl-3 text-muted-foreground">
          {event.note}
        </blockquote>
      )}
    </li>
  );
}
