import { sendMessage as gmailSend, type SendMessageOptions } from '../google/gmail.js';
import { sendMail as graphSend } from '../microsoft/graph.js';

/**
 * The outbound-email seam.
 *
 * Appointment reminders (`exams/reminders.ts`) go out through whichever
 * provider `EMAIL_PROVIDER` selects — Gmail by default, Outlook / Microsoft
 * 365 via Graph when set to `microsoft`. Both providers take the same
 * message shape and both send from the business's own connected mailbox.
 */

export type EmailMessage = SendMessageOptions;

export type EmailProviderName = 'google' | 'microsoft';

export interface EmailProvider {
  readonly name: EmailProviderName;
  /** Returns the provider's id (or a reference marker) for the sent message. */
  send(message: EmailMessage): Promise<string>;
}

export function emailProviderName(): EmailProviderName {
  return process.env.EMAIL_PROVIDER === 'microsoft' ? 'microsoft' : 'google';
}

const providers: Record<EmailProviderName, EmailProvider> = {
  google: { name: 'google', send: gmailSend },
  microsoft: { name: 'microsoft', send: graphSend },
};

export function getEmailProvider(): EmailProvider {
  return providers[emailProviderName()];
}
