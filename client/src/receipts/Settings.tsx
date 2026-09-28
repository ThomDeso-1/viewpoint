import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getSettings,
  getWaveHealth,
  logout,
  type Settings as SettingsData,
} from '../shared/api';
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

export function Settings({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [waveHealthy, setWaveHealthy] = useState<boolean | null>(null);

  const loadConnections = () => {
    Promise.all([
      getSettings().then(setSettings),
      getWaveHealth().then((h) => setWaveHealthy(h.healthy)),
    ]).catch(() => {});
  };

  useEffect(() => {
    loadConnections();
  }, []);

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
            description="Claude reads your receipts; Wave sends exam invoices; Outlook sends mail and syncs the calendar."
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


            <h3 className="vp-settings-subhead">Receipt photos</h3>
            <p className="vp-settings-lede">
              Kept on this computer only, in the app's <code>data/Receipts</code> folder — one folder
              per month, each file named by receipt date and vendor. The photo is sent to Claude once
              to be read; nothing else leaves the machine.
            </p>
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
