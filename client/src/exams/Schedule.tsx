import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import type { DateClickArg } from '@fullcalendar/interaction';
import type { DatesSetArg, EventClickArg, EventContentArg, EventInput } from '@fullcalendar/core';
import {
  getAppointments,
  getCalendarSyncStatus,
  syncCalendarNow,
  getPatients,
  type Appointment,
  type CalendarSyncStatus,
  type Patient,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { AppointmentForm } from './AppointmentForm';
import { AppointmentDetail } from './AppointmentDetail';

/**
 * The Outlook / Microsoft 365 calendar as a real month / week / day /
 * agenda view (FullCalendar). Click a day to book; click an event for its
 * detail and the actions that reach Outlook. Booking and rescheduling are
 * form-based (in a dialog) — there is no drag.
 */
export function Schedule({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const calRef = useRef<FullCalendar>(null);
  const [rows, setRows] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [syncStatus, setSyncStatus] = useState<CalendarSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [createStart, setCreateStart] = useState<string>('');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { showToast } = useToast();

  const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 768;
  const initialView = isNarrow() ? 'listWeek' : 'dayGridMonth';

  useEffect(() => {
    Promise.all([getPatients(), getCalendarSyncStatus().catch(() => null)])
      .then(([p, s]) => {
        setPatients(p);
        setSyncStatus(s);
      })
      .catch((err) => showToast((err as Error).message, 'error'));
  }, []);

  useEffect(() => {
    if (!range) return;
    let live = true;
    getAppointments(range.from, range.to)
      .then((appts) => {
        if (live) setRows(appts);
      })
      .catch((err) => showToast((err as Error).message, 'error'));
    return () => {
      live = false;
    };
  }, [range, reloadKey]);

  // Keep the view sensible when the window crosses the phone/desktop line.
  useEffect(() => {
    let wasNarrow = isNarrow();
    const onResize = () => {
      const narrow = isNarrow();
      if (narrow === wasNarrow) return;
      wasNarrow = narrow;
      calRef.current?.getApi().changeView(narrow ? 'listWeek' : 'dayGridMonth');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const refetch = () => setReloadKey((k) => k + 1);
  const reloadSyncStatus = () => getCalendarSyncStatus().then(setSyncStatus).catch(() => {});

  const handleDatesSet = (arg: DatesSetArg) => {
    setRange((prev) =>
      prev?.from === arg.startStr && prev?.to === arg.endStr ? prev : { from: arg.startStr, to: arg.endStr },
    );
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const result = await syncCalendarNow();
      setSyncStatus(result);
      showToast(
        result.pulled > 0 ? `Synced — ${result.pulled} change(s) from Outlook.` : 'Already up to date.',
        'success',
      );
      refetch();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const openCreate = (start?: string) => {
    setSelectedId(null);
    setCreateStart(start ?? '');
    setMode('create');
  };

  const handleDateClick = (info: DateClickArg) => {
    const d = new Date(info.date);
    if (info.allDay) d.setHours(9, 0, 0, 0); // month view has no time — default to 9am
    openCreate(d.toISOString());
  };

  const handleEventClick = (info: EventClickArg) => {
    setMode('closed');
    setSelectedId(info.event.id);
  };

  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;
  const events = useMemo(() => rows.map(toFcEvent), [rows]);

  return (
    <Screen width="wide" className="vp-schedule">
      <PageHeader
        title="Schedule"
        actions={
          <Button variant="primary" onClick={() => openCreate()} icon={<Icon name="plus" size={15} />}>
            Add
          </Button>
        }
      />

      <div className="vp-schedule-sync">
        <span>
          {syncStatus?.connected ? (
            <>Synced with Outlook · {formatSyncAge(syncStatus.lastSyncedAt)}</>
          ) : (
            <>
              Not connected to Outlook — <Link to="/settings">sign in from Settings</Link>.
            </>
          )}
        </span>
        {syncStatus?.connected && (
          <Button size="sm" variant="ghost" onClick={handleSyncNow} loading={syncing}>
            Sync now
          </Button>
        )}
      </div>

      <div className="schedule-calendar">
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView={initialView}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
          }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
          firstDay={1}
          height="auto"
          nowIndicator
          displayEventEnd
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
          events={events}
          eventContent={monthViewTimeOnly}
          datesSet={handleDatesSet}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
          noEventsContent="No appointments in this range."
        />
      </div>

      <Dialog
        open={mode === 'create' || mode === 'edit'}
        onClose={() => setMode('closed')}
        title={mode === 'edit' ? 'Edit appointment' : 'New appointment'}
      >
        {mode === 'create' && (
          <AppointmentForm
            patients={patients}
            defaultStartIso={createStart || undefined}
            onSaved={() => {
              setMode('closed');
              refetch();
              reloadSyncStatus();
            }}
            onCancel={() => setMode('closed')}
          />
        )}
        {mode === 'edit' && selected && (
          <AppointmentForm
            patients={patients}
            appointment={selected}
            onSaved={() => {
              setMode('closed');
              refetch();
            }}
            onCancel={() => setMode('closed')}
          />
        )}
      </Dialog>

      <Dialog
        open={mode === 'closed' && !!selected}
        onClose={() => setSelectedId(null)}
        ariaLabel="Appointment"
      >
        {selected && (
          <AppointmentDetail
            appointment={selected}
            patients={patients}
            ohipEnabled={ohipEnabled}
            onEdit={() => setMode('edit')}
            onChanged={refetch}
            onClose={() => setSelectedId(null)}
          />
        )}
      </Dialog>
    </Screen>
  );
}

// Month view is too cramped for a name — show just the time (with the usual
// status dot) and let the click-through detail carry the rest.
function monthViewTimeOnly(arg: EventContentArg) {
  if (arg.view.type !== 'dayGridMonth') return true;
  return (
    <>
      <div className="fc-daygrid-event-dot" style={{ borderColor: arg.borderColor }} />
      <span className="fc-event-time">{arg.timeText}</span>
    </>
  );
}

function toFcEvent(a: Appointment): EventInput {
  return {
    id: a.id,
    title: a.patient?.full_name ?? a.title ?? 'Appointment',
    start: a.starts_at,
    end: a.ends_at ?? undefined,
    editable: false,
    classNames: [
      a.status === 'cancelled' && 'fc-appt-cancelled',
      a.is_recurring === 1 && 'fc-appt-recurring',
      a.sync_state !== 'synced' && 'fc-appt-unsynced',
    ].filter(Boolean) as string[],
  };
}

/** "updated 3 min ago" / "updated just now" / "never synced". */
function formatSyncAge(iso: string | null): string {
  if (!iso) return 'never synced';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'updated just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  return `updated ${Math.floor(hours / 24)} d ago`;
}
