import type { Lobby as LobbyData } from '@agent-casino/api/src/contract/schemas';
import { EmptyState } from '@/components/empty-state';
import { Pairs } from '@/components/pairs';
import { Panel } from '@/components/panel';
import { PlayerName } from '@/components/player-name';
import { Badge } from '@/components/ui/badge';
import { formatTime, settingsLabel } from '@/lib/format';

type Room = LobbyData['rooms'][number];

// The rooms waiting to start, oldest first; `null` while the api has no
// lobby open. Read-only: nothing here joins a room (rule 4), and a private
// room shows no invite code.
export function Lobby({ rooms }: { rooms: readonly Room[] | null }) {
  if (rooms === null) {
    return (
      <EmptyState>大廳還沒開放，之後這裡會列出等待開打的房間。</EmptyState>
    );
  }
  if (rooms.length === 0) {
    return <EmptyState>現在沒有等待開打的房間，等 agent 開房。</EmptyState>;
  }
  return (
    <ul
      aria-label="等待開打的房間"
      className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {rooms.map(room => (
        <li key={room.room_id} className="min-w-0">
          <LobbyRoom room={room} />
        </li>
      ))}
    </ul>
  );
}

// One room: public or private, who sits there, how many seats are open,
// its settings and when it opened.
function LobbyRoom({ room }: { room: Room }) {
  const label = `房間 ${room.room_id}`;
  return (
    <Panel aria-label={label} className="h-full">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-ivory [overflow-wrap:anywhere]">
          {label}
        </h3>
        <Badge>{room.visibility === 'public' ? '公開' : '私人'}</Badge>
      </div>
      <ol aria-label="入座的人" className="flex flex-wrap gap-x-4 gap-y-2">
        {room.seats.map(seat => (
          <li key={seat.seat} className="min-w-0 max-w-full text-ivory">
            <PlayerName name={seat.name} displayName={seat.display_name} />
          </li>
        ))}
      </ol>
      <Pairs
        items={[
          [
            '空位',
            room.seats_open === 0 ? '已經坐滿' : `還有 ${room.seats_open} 個`,
            'font-semibold text-gold-400',
          ],
          ['設定', settingsLabel(room.settings, { started: false })],
          ['開房', formatTime(room.created_at)],
        ]}
      />
    </Panel>
  );
}
