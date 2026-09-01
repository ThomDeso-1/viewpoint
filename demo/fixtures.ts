/**
 * The fictional world the demo runs in.
 *
 * Dates are computed relative to today so the calendar always has
 * upcoming appointments and the reminder queue has something due —
 * fixed dates would silently stop being interesting a week after this
 * was written.
 */

export interface DemoPerson {
  name: string;
  email: string;
  phone: string;
  dob: string;
  /** One of the mock HCV numbers (only used if OHIP_ENABLED=true). */
  healthCard: string;
  versionCode: string;
  /** Verbatim "Status" column value for this patient's schedule row. */
  coverageStatus: string;
  /** Hours from now that this person's appointment sits. */
  hoursFromNow: number;
  /** Snap to business hours (09:00 onwards) rather than whatever time it is now. */
  businessHours?: boolean;
  reason: string;
  /** Merged schedule-row + note text, shown on the card. */
  notes?: string;
}

export const PEOPLE: DemoPerson[] = [
  {
    name: 'Ada Lovelace',
    email: 'ada.lovelace@example.com',
    phone: '(416) 555-0142',
    dob: '1985-12-10',
    healthCard: '1111111111', // valid
    versionCode: 'AB',
    coverageStatus: 'Eligible',
    // Soonest of the three, so with the demo's 36h reminder lead this
    // one is due the moment it's approved.
    hoursFromNow: 3,
    businessHours: true,
    reason: 'Annual eye exam, noticing some strain at the computer',
  },
  {
    name: 'Grace Hopper',
    email: 'grace.hopper@example.com',
    phone: '(416) 555-0177',
    dob: '1972-04-02',
    healthCard: '2222222222', // expired card
    versionCode: 'CD',
    coverageStatus: '$180 private pay',
    hoursFromNow: 30,
    businessHours: true,
    reason: 'New glasses prescription',
    notes: 'NA on the schedule — confirm attendance with the POA. Note reads private pay $180.',
  },
  {
    name: 'Alan Turing',
    email: 'alan.turing@example.com',
    phone: '(647) 555-0119',
    dob: '1990-06-23',
    healthCard: '4444444444', // not eligible
    versionCode: 'EF',
    coverageStatus: 'Not eligible',
    // Far enough out that its reminder is still pending — so the
    // demo shows both a sent and an unsent reminder.
    hoursFromNow: 60,
    businessHours: true,
    reason: 'Contact lens fitting',
  },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock parts, which is how the app reads requested times. */
export function localParts(date: Date): { day: string; time: string } {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * Rounds to the next half hour so demo times look like real bookings,
 * and optionally moves the slot into business hours.
 */
export function appointmentTime(hoursFromNow: number, businessHours = false): Date {
  const date = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);

  if (businessHours) {
    if (date.getHours() < 9) {
      date.setHours(9, 0, 0, 0);
    } else if (date.getHours() >= 17) {
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
    }
  }

  return date;
}

/** The appointment slot for a person, honouring their businessHours flag. */
export function appointmentFor(person: DemoPerson): Date {
  return appointmentTime(person.hoursFromNow, person.businessHours);
}

/** A spreadsheet-style export the folder scanner reads, one row per patient. */
export function patientFileCsv(people: DemoPerson[]): string {
  const header =
    'Patient,Date of Birth,Health Card,Version,Status,Phone,Email,Appointment Date,Appointment Time,Reason,Notes';
  const clean = (s: string) => s.replace(/,/g, ';');
  const rows = people.map((p) => {
    const { day, time } = localParts(appointmentFor(p));
    return [
      p.name,
      p.dob,
      p.healthCard,
      p.versionCode,
      p.coverageStatus, // the schedule's "Status" column — captured onto the request
      p.phone,
      p.email,
      day,
      time,
      clean(p.reason),
      clean(p.notes ?? ''),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export function extractionFor(person: DemoPerson) {
  const { day, time } = localParts(appointmentFor(person));

  return {
    patient_name: person.name,
    email: person.email,
    phone: person.phone,
    date_of_birth: person.dob,
    health_card_number: person.healthCard,
    health_card_version: person.versionCode,
    requested_date: day,
    requested_time: time,
    reason: person.reason,
    coverage_status: person.coverageStatus,
    notes: person.notes ?? null,
    confidence: 0.94,
  };
}

/** Receipts the fake Claude returns, cycled through in order. */
export const RECEIPTS = [
  { vendor: 'Staples', summary: 'Office supplies', subtotal: 42.47, tax: 5.52, total: 47.99 },
  { vendor: 'Petro-Canada', summary: 'Fuel', subtotal: 68.14, tax: 8.86, total: 77.0 },
  { vendor: 'Grand & Toy', summary: 'Printer paper and toner', subtotal: 112.39, tax: 14.61, total: 127.0 },
  { vendor: 'Bell Canada', summary: 'Business internet — monthly', subtotal: 89.0, tax: 11.57, total: 100.57 },
];

export const WAVE_BUSINESS = { id: 'demo-business-1', name: 'Viewpoint Vision Care (Demo)', isPersonal: false };

export const WAVE_ACCOUNTS = [
  { id: 'acct-expense-office', name: 'Office Supplies', type: 'Expenses', subtype: 'Operating Expense' },
  { id: 'acct-expense-auto', name: 'Vehicle Expense', type: 'Expenses', subtype: 'Operating Expense' },
  { id: 'acct-bank-chequing', name: 'Business Chequing', type: 'Assets', subtype: 'Cash & Bank' },
  { id: 'acct-card-visa', name: 'Business Visa', type: 'Liabilities & Credit Cards', subtype: 'Credit Card' },
  { id: 'acct-income-fees', name: 'Professional Fees', type: 'Income', subtype: 'Income' },
  { id: 'acct-income-sales', name: 'Product Sales', type: 'Income', subtype: 'Income' },
];

export const WAVE_PRODUCTS = [
  { id: 'prod-exam', name: 'Comprehensive Eye Exam', description: 'Full eye examination', unitPrice: 120 },
  { id: 'prod-fitting', name: 'Contact Lens Fitting', description: 'Fitting and trial lenses', unitPrice: 90 },
];

export const WAVE_SALES_TAXES = [{ id: 'tax-hst', name: 'HST (13%)', rate: 0.13 }];
