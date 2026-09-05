import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * Editable patient-email templates: storage, field-by-field fallback to
 * the built-in wording, and placeholder substitution. The compose steps
 * in reminders.ts / followups.ts are covered by their own suites.
 */
describe('email templates', () => {
  let ctx: TestContext;
  let mod: typeof import('../../server/exams/email-templates.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    mod = await import('../../server/exams/email-templates.js');
  });
  afterEach(() => ctx.teardown());

  it('returns the built-in default until an override is saved', () => {
    expect(mod.getEmailTemplate('reminder')).toEqual(mod.DEFAULT_TEMPLATES.reminder);
    expect(mod.isEmailTemplateCustomised('reminder')).toBe(false);
  });

  it('round-trips a saved override', () => {
    mod.setEmailTemplate('followup', { subject: 'Come back {{firstName}}', body: 'Hi {{firstName}}!' });
    expect(mod.getEmailTemplate('followup')).toEqual({
      subject: 'Come back {{firstName}}',
      body: 'Hi {{firstName}}!',
    });
    expect(mod.isEmailTemplateCustomised('followup')).toBe(true);
  });

  it('falls back per-field when a stored half is blank', () => {
    mod.setEmailTemplate('reminder', { subject: 'Custom subject', body: '   ' });
    const t = mod.getEmailTemplate('reminder');
    expect(t.subject).toBe('Custom subject');
    expect(t.body).toBe(mod.DEFAULT_TEMPLATES.reminder.body);
  });

  it('reset drops the override', () => {
    mod.setEmailTemplate('reminder', { subject: 'x', body: 'y' });
    mod.resetEmailTemplate('reminder');
    expect(mod.getEmailTemplate('reminder')).toEqual(mod.DEFAULT_TEMPLATES.reminder);
    expect(mod.isEmailTemplateCustomised('reminder')).toBe(false);
  });

  it('survives a corrupt stored value', async () => {
    const { setConfig } = await import('../../server/db/db.js');
    setConfig('email_template_reminder', '{not json');
    expect(mod.getEmailTemplate('reminder')).toEqual(mod.DEFAULT_TEMPLATES.reminder);
  });

  describe('renderTemplate', () => {
    it('substitutes known tokens and leaves unknown ones alone', () => {
      expect(
        mod.renderTemplate('Hello {{firstName}} from {{business}} / {{mystery}}', {
          firstName: 'Ada',
          business: 'Viewpoint',
        }),
      ).toBe('Hello Ada from Viewpoint / {{mystery}}');
    });

    it('tolerates whitespace inside the braces', () => {
      expect(mod.renderTemplate('{{ firstName }}', { firstName: 'Ada' })).toBe('Ada');
    });
  });

  it('renderEmailTemplate fills both halves of the active template', () => {
    mod.setEmailTemplate('reminder', { subject: '{{firstName}} — exam', body: 'at {{business}}' });
    expect(mod.renderEmailTemplate('reminder', { firstName: 'Ada', business: 'Viewpoint' })).toEqual({
      subject: 'Ada — exam',
      body: 'at Viewpoint',
    });
  });
});
