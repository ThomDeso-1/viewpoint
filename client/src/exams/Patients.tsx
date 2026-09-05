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
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { FollowupEmailComposer } from './FollowupEmailComposer';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

type PatientRow = Patient & { followup: PatientFollowup };

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
 * The patient directory, plus the recall worklist.
 *
 * Records are created automatically from exam requests, so "All patients"
 * is mostly a way to find someone. "Follow-ups due" is the list of
 * patients whose next eye exam is coming up (or overdue) and who haven't
 * re-booked.
 */
export function Patients() {
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [due, setDue] = useState<FollowupDue[]>([]);
  const [view, setView] = useState<'all' | 'due'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const navigate = useNavigate();

  const loadDue = () =>
    getFollowupsDue()
      .then((r) => setDue(r.due))
      .catch((err) => showToast((err as Error).message, 'error'));

  useEffect(() => {
    Promise.all([
      getPatients()
        .then((rows) => setPatients(rows as PatientRow[]))
        .catch((err) => showToast((err as Error).message, 'error')),
      loadDue(),
    ]).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return patients;
    return patients.filter(
      (p) =>
        p.full_name.toLowerCase().includes(term) ||
        (p.email ?? '').toLowerCase().includes(term) ||
        (p.phone ?? '').toLowerCase().includes(term),
    );
  }, [patients, search]);

  if (loading) {
    return (
      <Screen width="wide" className="vp-patients">
        <PageHeader title="Patients" />
        <SkeletonRows rows={6} />
      </Screen>
    );
  }

  return (
    <Screen width="wide" className="vp-patients">
      <PageHeader title="Patients" />

      <div className="vp-segmented">
        <button
          type="button"
          aria-pressed={view === 'all'}
          className={view === 'all' ? 'is-active' : ''}
          onClick={() => setView('all')}
        >
          All patients
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
            onOpen={(id) => navigate(`/patients/${id}`)}
          />
        ) : (
          <DueList
            due={due}
            onOpen={(id) => navigate(`/patients/${id}`)}
            onChanged={() => {
              loadDue();
              getPatients()
                .then((rows) => setPatients(rows as PatientRow[]))
                .catch(() => {});
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
  onOpen,
}: {
  patients: PatientRow[];
  filtered: PatientRow[];
  search: string;
  setSearch: (v: string) => void;
  onOpen: (id: string) => void;
}) {
  if (patients.length === 0) {
    return (
      <EmptyState icon="users" title="No patients yet">
        Records are created automatically when an exam request comes in.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="vp-search vp-mb-2">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or phone"
          aria-label="Search patients"
        />
      </div>

      <p className="vp-count">
        {filtered.length} of {patients.length}
      </p>

      {filtered.length === 0 ? (
        <EmptyState icon="search" title={`No patients match “${search}”`} />
      ) : (
        <div className="vp-patient-list">
          {filtered.map((patient) => (
            <button key={patient.id} className="vp-patient-row" onClick={() => onOpen(patient.id)}>
              <span className="vp-patient-main">
                <span className="vp-patient-name">{patient.full_name}</span>
                <span className="vp-muted">
                  {patient.email ?? patient.phone ?? 'No contact details'}
                </span>
                <span className="vp-muted">
                  {appointmentSummary(patient.followup)}
                  {patient.followup.due ? <span className="vp-pill vp-pill--attention vp-pill--dot"> due</span> : null}
                </span>
              </span>
              <span className={patient.has_health_card ? 'vp-mono vp-ok-text' : 'vp-muted'}>
                {patient.has_health_card ? patient.health_card_masked : 'No health card'}
              </span>
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
