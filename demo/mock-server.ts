import express, { type Request, type Response } from 'express';
import {
  PEOPLE,
  RECEIPTS,
  WAVE_ACCOUNTS,
  WAVE_BUSINESS,
  WAVE_PRODUCTS,
  WAVE_SALES_TAXES,
  appointmentFor,
  extractionFor,
  type DemoPerson,
} from './fixtures.js';

/**
 * A local stand-in for every external service the app talks to:
 * Anthropic, Wave, Google OAuth, Gmail send, Google Calendar, and
 * Microsoft OAuth + Graph send (the Outlook alternative).
 *
 * The app's own clients are unmodified — they make the same requests
 * they would in production and parse the same response shapes. Only the
 * base URLs move (see server/services/endpoints.ts), so the GraphQL
 * parsing, MIME decoding, OAuth exchange, and error handling all still
 * get exercised. A mock that bypassed those would not surface the bugs
 * that live in them.
 *
 * Everything sent *to* this server is captured and shown at
 * http://localhost:4000 — the invoices "raised" and emails "sent" are
 * visible there instead of reaching anyone.
 */

const PORT = Number(process.env.DEMO_MOCK_PORT || 4000);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Captured activity, for the dashboard ──

interface SentEmail {
  at: string;
  to: string;
  subject: string;
  body: string;
}
interface CreatedInvoice {
  at: string;
  id: string;
  number: string;
  customer: string;
  total: number;
  lines: { description: string; quantity: number; unitPrice: number }[];
  status: string;
}

const sentEmails: SentEmail[] = [];
const invoices: CreatedInvoice[] = [];
const customers = new Map<string, { id: string; name: string; email: string | null }>();
const expenses: { at: string; description: string; amount: number }[] = [];
let requestCount = 0;

function log(service: string, detail: string): void {
  requestCount++;
  console.log(`  [${String(requestCount).padStart(3)}] ${service.padEnd(10)} ${detail}`);
}

// ── Anthropic ──

app.post('/anthropic/v1/messages', (req: Request, res: Response) => {
  const body = req.body ?? {};
  const messages = body.messages ?? [];
  const content = messages[0]?.content;

  const asText = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      : '';
  const hasImage = Array.isArray(content) && content.some((c: any) => c.type === 'image');
  const hasDocument = Array.isArray(content) && content.some((c: any) => c.type === 'document');

  // The key-validation ping.
  if (asText.trim() === 'Say OK.') {
    log('claude', 'API key validation');
    return res.json({ content: [{ type: 'text', text: 'OK' }] });
  }

  if (hasImage) {
    // Cycled so a batch of receipts doesn't come back identical.
    const receipt = RECEIPTS[expenses.length % RECEIPTS.length];
    log('claude', `receipt extraction → ${receipt.vendor} $${receipt.total}`);

    return res.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            receipt_date: new Date().toISOString().slice(0, 10),
            vendor: receipt.vendor,
            items: [{ description: receipt.summary, amount: receipt.subtotal }],
            summary_description: receipt.summary,
            subtotal: receipt.subtotal,
            taxes: [{ type: 'HST', rate: 0.13, amount: receipt.tax }],
            total: receipt.total,
            currency: 'CAD',
            confidence: 'high',
          }),
        },
      ],
    });
  }

  // A patient files scan. The whole file went to Claude, so return every
  // person whose name appears in it (or all of them for a text-free PDF).
  const named = PEOPLE.filter((p) => asText.includes(p.name));
  const found = named.length > 0 ? named : hasDocument ? PEOPLE : [PEOPLE[0]];
  log('claude', `patient batch extraction → ${found.length} patient(s)`);

  return res.json({
    content: [{ type: 'text', text: JSON.stringify(found.map(extractionFor)) }],
  });
});

// ── Wave GraphQL ──

function accountNode(a: (typeof WAVE_ACCOUNTS)[number]) {
  return {
    id: a.id,
    name: a.name,
    type: { name: a.type },
    subtype: { name: a.subtype },
    isArchived: false,
  };
}

const onePage = { currentPage: 1, totalPages: 1 };

app.post('/wave/graphql', (req: Request, res: Response) => {
  const query: string = req.body?.query ?? '';
  const variables = req.body?.variables ?? {};

  const has = (needle: string) => query.includes(needle);

  if (has('businesses(')) {
    log('wave', 'list businesses');
    return res.json({ data: { businesses: { edges: [{ node: WAVE_BUSINESS }] } } });
  }

  if (has('accounts(')) {
    log('wave', 'list accounts');
    return res.json({
      data: {
        business: {
          accounts: { pageInfo: onePage, edges: WAVE_ACCOUNTS.map((a) => ({ node: accountNode(a) })) },
        },
      },
    });
  }

  if (has('salesTaxes')) {
    log('wave', 'list sales taxes');
    return res.json({
      data: { business: { salesTaxes: { edges: WAVE_SALES_TAXES.map((t) => ({ node: t })) } } },
    });
  }

  if (has('products(')) {
    log('wave', 'list products');
    return res.json({
      data: {
        business: {
          products: {
            pageInfo: onePage,
            edges: WAVE_PRODUCTS.map((p) => ({ node: { ...p, isArchived: false } })),
          },
        },
      },
    });
  }

  if (has('customers(')) {
    log('wave', 'list customers');
    return res.json({
      data: {
        business: {
          customers: { pageInfo: onePage, edges: [...customers.values()].map((node) => ({ node })) },
        },
      },
    });
  }

  if (has('customerCreate')) {
    const input = variables.input ?? {};
    const id = `cust-${customers.size + 1}`;
    const customer = { id, name: input.name, email: input.email ?? null };
    customers.set(id, customer);
    log('wave', `create customer → ${input.name}`);
    return res.json({ data: { customerCreate: { didSucceed: true, inputErrors: null, customer } } });
  }

  if (has('invoiceCreate')) {
    const input = variables.input ?? {};
    const lines = (input.items ?? []).map((i: any) => ({
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    }));
    const total = lines.reduce((sum: number, l: any) => sum + l.quantity * l.unitPrice, 0);
    const id = `inv-${invoices.length + 1}`;
    const number = String(1000 + invoices.length + 1);
    const customer = customers.get(input.customerId)?.name ?? input.customerId;

    invoices.push({
      at: new Date().toISOString(),
      id,
      number,
      customer,
      total,
      lines,
      status: 'DRAFT',
    });
    log('wave', `create invoice → ${customer} $${total.toFixed(2)} (${lines.length} line(s))`);

    return res.json({
      data: {
        invoiceCreate: {
          didSucceed: true,
          inputErrors: null,
          invoice: {
            id,
            invoiceNumber: number,
            status: 'DRAFT',
            viewUrl: `http://localhost:${PORT}/#invoice-${id}`,
            pdfUrl: `http://localhost:${PORT}/#invoice-${id}`,
            total: { value: total },
          },
        },
      },
    });
  }

  if (has('invoiceApprove')) {
    const found = invoices.find((i) => i.id === variables.input?.invoiceId);
    if (found) found.status = 'APPROVED';
    log('wave', `approve invoice → ${variables.input?.invoiceId}`);
    return res.json({
      data: {
        invoiceApprove: {
          didSucceed: true,
          inputErrors: null,
          invoice: {
            id: variables.input?.invoiceId,
            invoiceNumber: found?.number ?? null,
            status: 'APPROVED',
            viewUrl: null,
            pdfUrl: null,
            total: { value: found?.total ?? 0 },
          },
        },
      },
    });
  }

  if (has('invoiceSend')) {
    const found = invoices.find((i) => i.id === variables.input?.invoiceId);
    if (found) found.status = 'SENT';
    if (variables.input?.to) {
      sentEmails.push({
        at: new Date().toISOString(),
        to: variables.input.to,
        subject: `Invoice ${found?.number ?? ''} from Viewpoint Vision Care`,
        body: `[Wave would email the invoice PDF here]\n\nTotal: $${found?.total.toFixed(2) ?? '0.00'}`,
      });
    }
    log('wave', `send invoice → ${variables.input?.to}`);
    return res.json({ data: { invoiceSend: { didSucceed: true, inputErrors: null } } });
  }

  if (has('moneyTransactionCreate')) {
    const input = variables.input ?? {};
    expenses.push({
      at: new Date().toISOString(),
      description: input.description,
      amount: input.anchor?.amount ?? 0,
    });
    log('wave', `create expense → ${input.description} $${input.anchor?.amount}`);
    return res.json({
      data: {
        moneyTransactionCreate: {
          didSucceed: true,
          inputErrors: null,
          transaction: { id: `txn-${expenses.length}` },
        },
      },
    });
  }

  log('wave', `unhandled query: ${query.slice(0, 60).replace(/\s+/g, ' ')}`);
  return res.json({ errors: [{ message: 'Demo mock does not implement this query.' }] });
});

// ── Google OAuth ──

app.get('/google/oauth/authorize', (req: Request, res: Response) => {
  const redirectUri = String(req.query.redirect_uri ?? '');
  const state = String(req.query.state ?? '');
  log('google', 'consent screen (auto-approved)');

  // No consent UI: bounce straight back with a code, so the app's real
  // callback and token-exchange path still runs.
  const url = new URL(redirectUri);
  url.searchParams.set('code', 'demo-auth-code');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/google/oauth/token', (req: Request, res: Response) => {
  const grant = req.body?.grant_type;
  log('google', `token exchange (${grant})`);
  res.json({
    access_token: `demo-access-${Date.now()}`,
    refresh_token: 'demo-refresh-token',
    expires_in: 3600,
    scope: 'gmail.readonly gmail.send calendar.events',
    token_type: 'Bearer',
  });
});

app.get('/google/oauth/userinfo', (_req: Request, res: Response) => {
  res.json({ email: 'reception@viewpoint-demo.example.com' });
});

// ── Gmail (send only — the app no longer reads the inbox) ──

app.post('/gmail/v1/users/me/messages/send', (req: Request, res: Response) => {
  const raw = Buffer.from(String(req.body?.raw ?? ''), 'base64url').toString('utf-8');
  const to = /^To: (.*)$/m.exec(raw)?.[1] ?? 'unknown';
  const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '(no subject)';
  const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');

  sentEmails.push({ at: new Date().toISOString(), to, subject, body });
  log('gmail', `send → ${to}`);

  res.json({ id: `demo-sent-${sentEmails.length}`, threadId: 'demo-thread-sent' });
});

// ── Microsoft OAuth + Graph (Outlook send alternative) ──

app.get('/microsoft/oauth/authorize', (req: Request, res: Response) => {
  const redirectUri = String(req.query.redirect_uri ?? '');
  const state = String(req.query.state ?? '');
  log('microsoft', 'consent screen (auto-approved)');

  const url = new URL(redirectUri);
  url.searchParams.set('code', 'demo-ms-auth-code');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/microsoft/oauth/token', (req: Request, res: Response) => {
  const grant = req.body?.grant_type;
  log('microsoft', `token exchange (${grant})`);
  res.json({
    access_token: `demo-ms-access-${Date.now()}`,
    refresh_token: 'demo-ms-refresh-token',
    expires_in: 3600,
    scope: 'Mail.Send User.Read offline_access',
    token_type: 'Bearer',
  });
});

app.get('/graph/v1.0/me', (_req: Request, res: Response) => {
  res.json({ mail: 'reception@viewpoint-demo.example.com', userPrincipalName: 'reception@viewpoint-demo.example.com' });
});

app.post('/graph/v1.0/me/sendMail', (req: Request, res: Response) => {
  const message = req.body?.message ?? {};
  const to = message.toRecipients?.[0]?.emailAddress?.address ?? 'unknown';
  sentEmails.push({
    at: new Date().toISOString(),
    to,
    subject: message.subject ?? '(no subject)',
    body: message.body?.content ?? '',
  });
  log('graph', `sendMail → ${to}`);
  res.status(202).end();
});

// ── Google Calendar ──

app.get('/calendar/v3/calendars/:calendarId/events', (_req: Request, res: Response) => {
  log('calendar', 'list events');

  res.json({
    items: PEOPLE.map((person: DemoPerson, i: number) => {
      const start = appointmentFor(person);
      return {
        id: `demo-event-${i + 1}`,
        summary: `Eye exam — ${person.name}`,
        description: person.reason,
        location: '123 Demo Street, Toronto',
        status: 'confirmed',
        start: { dateTime: start.toISOString() },
        end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString() },
        attendees: [{ email: person.email }],
      };
    }),
  });
});

// ── Dashboard ──

app.get('/_demo/state', (_req: Request, res: Response) => {
  res.json({ sentEmails, invoices, expenses, customers: [...customers.values()] });
});

app.post('/_demo/reset', (_req: Request, res: Response) => {
  sentEmails.length = 0;
  invoices.length = 0;
  expenses.length = 0;
  customers.clear();
  log('demo', 'state reset');
  res.json({ success: true });
});

app.get('/', (_req: Request, res: Response) => {
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

  const emailRows = sentEmails.length
    ? sentEmails
        .map(
          (e) => `<article>
            <header><strong>${escape(e.subject)}</strong> → ${escape(e.to)}
            <time>${new Date(e.at).toLocaleString()}</time></header>
            <pre>${escape(e.body)}</pre>
          </article>`,
        )
        .reverse()
        .join('')
    : '<p class="empty">Nothing sent yet.</p>';

  const invoiceRows = invoices.length
    ? invoices
        .map(
          (i) => `<article>
            <header><strong>Invoice ${i.number}</strong> — ${escape(i.customer)}
            <span class="badge">${i.status}</span>
            <time>${new Date(i.at).toLocaleString()}</time></header>
            <table>${i.lines
              .map(
                (l) =>
                  `<tr><td>${escape(l.description)}</td><td>${l.quantity} × $${l.unitPrice.toFixed(2)}</td><td>$${(l.quantity * l.unitPrice).toFixed(2)}</td></tr>`,
              )
              .join('')}<tr class="total"><td colspan="2">Total</td><td>$${i.total.toFixed(2)}</td></tr></table>
          </article>`,
        )
        .reverse()
        .join('')
    : '<p class="empty">No invoices raised yet.</p>';

  const expenseRows = expenses.length
    ? `<ul>${expenses
        .map((e) => `<li>${escape(e.description)} — $${e.amount.toFixed(2)}</li>`)
        .reverse()
        .join('')}</ul>`
    : '<p class="empty">No receipts uploaded yet.</p>';

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Demo services</title>
<meta http-equiv="refresh" content="10">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  .sub { color: #888; margin-bottom: 2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .04em;
       color: #888; margin: 2rem 0 .75rem; }
  article { border: 1px solid #8883; border-radius: .5rem; padding: .75rem 1rem; margin-bottom: .75rem; }
  header { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .5rem; }
  time { color: #888; font-size: .8rem; margin-left: auto; }
  pre { white-space: pre-wrap; font-size: .82rem; margin: 0; color: #666; }
  table { width: 100%; font-size: .85rem; border-collapse: collapse; }
  td { padding: .15rem 0; }
  td:last-child { text-align: right; }
  .total td { border-top: 1px solid #8883; font-weight: 700; padding-top: .35rem; }
  .badge { font-size: .7rem; font-weight: 700; background: #2563eb; color: #fff;
           padding: .1rem .4rem; border-radius: .25rem; }
  .empty { color: #888; font-style: italic; }
  ul { padding-left: 1.1rem; font-size: .9rem; }
  form { margin-top: 2rem; }
  button { font: inherit; padding: .4rem .8rem; border-radius: .4rem; border: 1px solid #8886;
           background: transparent; color: inherit; cursor: pointer; }
</style></head>
<body>
  <h1>Demo services</h1>
  <p class="sub">Standing in for Anthropic, Wave, Gmail send and Google Calendar.
     Nothing here leaves your machine. Refreshes every 10s.</p>

  <h2>Emails "sent" (${sentEmails.length})</h2>
  ${emailRows}

  <h2>Invoices "raised" (${invoices.length})</h2>
  ${invoiceRows}

  <h2>Receipt expenses "posted" (${expenses.length})</h2>
  ${expenseRows}

  <form method="post" action="/_demo/reset"><button type="submit">Clear captured activity</button></form>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`\n  Demo services listening on http://localhost:${PORT}`);
  console.log('  Standing in for: Anthropic · Wave · Google OAuth · Gmail send · Calendar · Microsoft Graph');
  console.log(`  Captured invoices and emails: http://localhost:${PORT}\n`);
});
