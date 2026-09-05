import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getSettings,
  getQueueStatus,
  retryAllFailed,
  getWaveHealth,
  logout,
  type Settings as SettingsData,
  type QueueStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { ClaudeSettings } from './ClaudeSettings';
import { WaveSettings } from './WaveSettings';
import { MicrosoftSettings } from '../exams/MicrosoftSettings';
import { ExamSettings } from '../exams/ExamSettings';
import { EmailTemplateSettings } from '../exams/EmailTemplateSettings';
import { OhipSettings } from '../exams/OhipSettings';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Section } from '../ui/Card';
import { Button } from '../ui/Button';
import { KeyValueList, KeyValue } from '../ui/KeyValue';

export function Settings({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [waveHealthy, setWaveHealthy] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { showToast } = useToast();

  const loadConnections = () => {
    Promise.all([
      getSettings().then(setSettings),
      getWaveHealth().then((h) => setWaveHealthy(h.healthy)),
    ]).catch(() => {});
  };

  useEffect(() => {
    loadConnections();
    getQueueStatus().then(setQueue).catch(() => {});
  }, []);

  const handleRetryAll = async () => {
    setRetrying(true);
    try {
      await retryAllFailed();
      setQueue(await getQueueStatus());
    } catch (err) {
      showToast((err as Error).message || 'Could not retry failed uploads.');
    } finally {
      setRetrying(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const sections: { id: string; label: string }[] = [
    { id: 'connections', label: 'Connections' },
    { id: 'exam-workflow', label: 'Exam workflow' },
    { id: 'email-templates', label: 'Email templates' },
    ...(ohipEnabled ? [{ id: 'ohip', label: 'OHIP checks' }] : []),
    { id: 'privacy', label: 'Privacy & data' },
    { id: 'account', label: 'Account' },
  ];

  return (
    <Screen width="wide" className="vp-settings">
      <PageHeader title="Settings" />

      <div className="vp-settings-layout">
        <nav className="vp-settings-nav" aria-label="Settings sections">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="vp-settings-body">
          <Section
            id="connections"
            title="Connections"
            description="Claude reads your receipts; Wave records expenses and invoices; Outlook sends mail and syncs the calendar."
          >
            <ClaudeSettings settings={settings} onSaved={loadConnections} />
            <WaveSettings settings={settings} waveHealthy={waveHealthy} onSaved={loadConnections} />
            <MicrosoftSettings />
          </Section>

          <Section
            id="exam-workflow"
            title="Exam workflow"
            description="The patient-files folder, extraction confidence, invoicing defaults and reminder timing."
          >
            <ExamSettings />
          </Section>

          <Section id="email-templates" title="Email templates">
            <EmailTemplateSettings />
          </Section>

          {ohipEnabled && (
            <Section id="ohip" title="OHIP checks">
              <OhipSettings />
            </Section>
          )}

          <Section id="privacy" title="Privacy & data">
            <p className="vp-settings-lede">
              Every time patient data is read or changed, and everything sent to a patient, is recorded
              locally.
            </p>
            <Button variant="secondary" to="/audit">
              View access log
            </Button>

            {queue && (
              <>
                <h3 className="vp-settings-subhead">Upload queue</h3>
                <KeyValueList>
                  <KeyValue label="Captured">{queue.captured}</KeyValue>
                  <KeyValue label="Pending review">{queue.pending}</KeyValue>
                  <KeyValue label="Failed">
                    {queue.failed > 0 ? <span className="vp-error-text">{queue.failed}</span> : 0}
                  </KeyValue>
                  <KeyValue label="Uploaded">{queue.uploaded}</KeyValue>
                </KeyValueList>
                {queue.failed > 0 && (
                  <Button variant="secondary" onClick={handleRetryAll} loading={retrying}>
                    Retry All Failed
                  </Button>
                )}
              </>
            )}
          </Section>

          <Section id="account" title="Account">
            <Button variant="danger" onClick={handleLogout}>
              Sign Out
            </Button>
            <p className="vp-settings-version">Viewpoint v1.0.0</p>
          </Section>
        </div>
      </div>
    </Screen>
  );
}
