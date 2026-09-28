import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getPatients,
  getFollowupsDue,
  dismissFollowup,
  snoozeFollowup,
  type Patient,
  type PatientFollowup,
  type FollowupDue,
  type ClientType,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { FollowupEmailComposer } from './FollowupEmailComposer';
import { WaveImportDialog, CLIENT_TYPE_LABEL } from './WaveImport';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Pill } from '../ui/Pill';

type PatientRow = Patient & { followup: PatientFollowup };

/** The "All clients" filter: a client type, or the import's duplicate flag. */
type ClientFilter = 'all' | ClientType | 'duplicates';

const FILTERS: { key: ClientFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'patient', label: 'Patients' },
  { key: 'customer', label: 'Customers' },
  { key: 'business', label: 'Businesses' },
  { key: 'duplicates', label: 'Possible duplicates' },
];

/** "12 Mar 2026", or "—" for a missing date. */
function fmtDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function overdueLabel(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return `due ${fmtDay(iso)}`;
  if (days < 45) return `due ${fmtDay(iso)}`;
  const months = Math.round(days / 30);
  return `overdue ${months} month${months === 1 ? '' : 's'}`;
}

/**
 * The client directory, plus the recall worklist.
 *
 * "Clients" since migration 011 — patients, eyewear customers and
 * businesses in one list, filterable by type. Records arrive
 * automatically from exam requests, or in bulk from Wave ("Import from
 * Wave"). "Follow-ups due" is the list of patients whose next eye exam is
 * coming up (or overdue) and who haven't re-booked.
 */
export function Patients() {
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [due, setDue] = useState<FollowupDue[]>([]);
  const [view, setView] = useState<'all' | 'due'>('all');
  const [filter, setFilter] = useState<ClientFilter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const { showToast } = useToast();
  const navigate = useNavigate();

  const loadPatients = () =>
    getPatients()
      .then((rows) => setPatients(rows as PatientRow[]))
      .catch((err) => showToast((err as Error).message, 'error'));

  const loadDue = () =>
    getFollowupsDue()
      .then((r) => setDue(r.due))
      .catch((err) => showToast((err as Error).message, 'error'));

  useEffect(() => {
    Promise.all([loadPatients(), loadDue()]).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return patients.filter((p) => {
      if (filter === 'duplicates' ? !p.possible_duplicate_of : filter !== 'all' && p.client_type !== filter) {
        return false;
      }
      return (
        !term ||
        p.full_name.toLowerCase().includes(term) ||
        (p.email ?? '').toLowerCase().includes(term) ||
        (p.phone ?? '').toLowerCase().includes(term)
      );
    });
  }, [patients, search, filter]);

  const importButton = (
    <Button size="sm" variant="secondary" onClick={() => setImporting(true)} icon={<Icon name="download" size={13} />}>
      Import from Wave
    </Button>
  );

  if (loading) {
    return (
      <Screen width="wide" className="vp-patients">
        <PageHeader title="Clients" />
        <SkeletonRows rows={6} />
      </Screen>
    );
  }

  return (
    <Screen width="wide" className="vp-patients">
      <PageHeader title="Clients" actions={importButton} />

      <WaveImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={loadPatients}
      />

      <div className="vp-segmented">
        <button
          type="button"
          aria-pressed={view === 'all'}
          className={view === 'all' ? 'is-active' : ''}
          onClick={() => setView('all')}
        >
          All clients
        </button>
        <button
          type="button"
          aria-pressed={view === 'due'}
          className={view === 'due' ? 'is-active' : ''}
          onClick={() => setView('due')}
        >
          Follow-ups due{due.length > 0 ? ` (${due.length})` : ''}
        </button>
      </div>

        {view === 'all' ? (
          <AllPatients
            patients={patients}
            filtered={filtered}
            search={search}
            setSearch={setSearch}
            filter={filter}
            setFilter={setFilter}
            onOpen={(id) => navigate(`/patients/${id}`)}
          />
        ) : (
          <DueList
            due={due}
            onOpen={(id) => navigate(`/patients/${id}`)}
            onChanged={() => {
              loadDue();
              loadPatients();
            }}
          />
        )}
    </Screen>
  );
}

function appointmentSummary(f: PatientFollowup): string {
  const last = f.last_appointment_at ? `Last: ${fmtDay(f.last_appointment_at)}` : null;
  const upcoming =
    f.followup_source === 'booked'
      ? `Current: ${fmtDay(f.current_appointment_at)}`
      : f.followup_date
        ? `Follow-up: ${fmtDay(f.followup_date)}`
        : null;

  if (!last && !upcoming) return 'No appointments';
  return [last, upcoming].filter(Boolean).join(' · ');
}

function AllPatients({
  patients,
  filtered,
  search,
  setSearch,
  filter,
  setFilter,
  onOpen,
}: {
  patients: PatientRow[];
  filtered: PatientRow[];
  search: string;
  setSearch: (v: string) => void;
  filter: ClientFilter;
  setFilter: (f: ClientFilter) => void;
  onOpen: (id: string) => void;
}) {
  if (patients.length === 0) {
    return (
      <EmptyState icon="users" title="No clients yet">
        Records are created automatically when an exam request comes in, or you can import your
        customer list from Wave.
      </EmptyState>
    );
  }

  const duplicateCount = patients.filter((p) => p.possible_duplicate_of).length;
  const filterLabel = FILTERS.find((f) => f.key === filter)!.label.toLowerCase();

  return (
    <>
      <div className="vp-search vp-mb-2">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or phone"
          aria-label="Search clients"
        />
      </div>

      <div className="vp-segmented vp-client-filter" role="group" aria-label="Filter clients">
        {FILTERS.filter((f) => f.key !== 'duplicates' || duplicateCount > 0).map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            className={filter === f.key ? 'is-active' : ''}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key === 'duplicates' ? ` (${duplicateCount})` : ''}
          </button>
        ))}
      </div>

      <p className="vp-count">
        {filtered.length} of {patients.length}
      </p>

      {filtered.length === 0 ? (
        <EmptyState
          icon="search"
          title={search ? `No ${filter === 'all' ? 'clients' : filterLabel} match “${search}”` : `No ${filterLabel}`}
        />
      ) : (
        <div className="vp-patient-list">
          {filtered.map((patient) => (
            <button key={patient.id} className="vp-patient-row" onClick={() => onOpen(patient.id)}>
              <span className="vp-patient-main">
                <span className="vp-patient-name">
                  {patient.full_name}
                  {patient.client_type !== 'patient' && (
                    <Pill tone="info" dot={false}>{CLIENT_TYPE_LABEL[patient.client_type]}</Pill>
                  )}
                  {patient.possible_duplicate_of && <Pill tone="attention">Possible duplicate</Pill>}
                </span>
                <span className="vp-muted">
                  {patient.email ?? patient.phone ?? 'No contact details'}
                </span>
                <span className="vp-muted">
                  {appointmentSummary(patient.followup)}
                  {patient.followup.due ? <span className="vp-pill vp-pill--attention vp-pill--dot"> due</span> : null}
                </span>
              </span>
              {/* A missing card only matters for a patient. */}
              {patient.has_health_card || patient.client_type === 'patient' ? (
                <span className={patient.has_health_card ? 'vp-mono vp-ok-text' : 'vp-muted'}>
                  {patient.has_health_card ? patient.health_card_masked : 'No health card'}
                </span>
              ) : (
                <span />
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DueList({
  due,
  onOpen,
  onChanged,
}: {
  due: FollowupDue[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [composingFor, setComposingFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (due.length === 0) {
    return (
      <EmptyState icon="check" title="No follow-ups due">
        Everyone who's due back has an appointment booked.
      </EmptyState>
    );
  }

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await fn();
      showToast(done, 'success');
      onChanged();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="vp-stack">
      {due.map((row) => (
        <div key={row.patient_id} className="vp-due-card">
          <div className="vp-due-head">
            <button className="vp-due-name" onClick={() => onOpen(row.patient_id)}>
              {row.full_name}
            </button>
            <span className="vp-muted">
              {overdueLabel(row.followup_date)}
              {row.last_appointment_at ? ` · last exam ${fmtDay(row.last_appointment_at)}` : ''}
              {row.followup_last_emailed_at
                ? ` · emailed ${fmtDay(row.followup_last_emailed_at)}`
                : ''}
            </span>
            {!row.email && row.mode === 'followup' ? (
              <span className="vp-muted">No email on file — can't send a recall.</span>
            ) : null}
          </div>

          {composingFor === row.patient_id ? (
            <FollowupEmailComposer
              patientId={row.patient_id}
              onSent={() => {
                setComposingFor(null);
                onChanged();
              }}
              onCancel={() => setComposingFor(null)}
            />
          ) : (
            <div className="vp-due-actions">
              {row.mode === 'followup' && row.email ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setComposingFor(row.patient_id)}
                  disabled={busy === row.patient_id}
                >
                  Draft email
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  act(row.patient_id, () => snoozeFollowup(row.patient_id, 1), 'Snoozed 1 month.')
                }
                disabled={busy === row.patient_id}
              >
                Snooze 1 month
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  act(row.patient_id, () => dismissFollowup(row.patient_id), 'Marked done.')
                }
                disabled={busy === row.patient_id}
              >
                Done
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
