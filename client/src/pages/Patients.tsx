import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getPatients, type Patient } from '../api/client';
import { useToast } from '../components/Toast';

/**
 * The patient directory.
 *
 * Records are created automatically from exam requests, so this is mostly
 * a way to find someone and open their history rather than a data-entry
 * screen.
 */
export function Patients() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    getPatients()
      .then(setPatients)
      .catch((err) => showToast((err as Error).message, 'error'))
      .finally(() => setLoading(false));
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
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Patients</h1>
        <div className="header-actions">
          <Link to="/inbox" className="button-link">
            Exam requests
          </Link>
          <Link to="/schedule" className="button-link">
            Schedule
          </Link>
        </div>
      </header>

      {patients.length === 0 ? (
        <p className="empty-state">
          No patients yet. Records are created automatically when an exam request comes in.
        </p>
      ) : (
        <>
          <input
            className="auth-input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or phone"
            aria-label="Search patients"
          />

          <p className="muted" style={{ margin: '10px 0' }}>
            {filtered.length} of {patients.length}
          </p>

          {filtered.length === 0 ? (
            <p className="empty-state">No patients match “{search}”.</p>
          ) : (
            <div className="patient-list">
              {filtered.map((patient) => (
                <button
                  key={patient.id}
                  className="patient-row"
                  onClick={() => navigate(`/patients/${patient.id}`)}
                >
                  <div className="patient-row-main">
                    <span className="patient-row-name">{patient.full_name}</span>
                    <span className="muted">
                      {patient.email ?? patient.phone ?? 'No contact details'}
                    </span>
                  </div>
                  <span className={patient.has_health_card ? 'eligibility-ok' : 'muted'}>
                    {patient.has_health_card ? patient.health_card_masked : 'No health card'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
