import fs from 'fs';
import path from 'path';

/**
 * Persists credential updates from the onboarding wizard / settings page
 * to the .env file and applies them to the running process immediately,
 * so no server restart is required.
 */

const ENV_PATH = path.join(process.cwd(), '.env');

export function updateEnvConfig(values: Record<string, string>): void {
  let lines: string[] = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n').filter((line) => line.trim() !== '');
  }

  const seen = new Set<string>();

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${escapeValue(values[match[1]])}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      updatedLines.push(`${key}=${escapeValue(value)}`);
    }
  }

  fs.writeFileSync(ENV_PATH, updatedLines.join('\n') + '\n', { mode: 0o600 });

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function escapeValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
