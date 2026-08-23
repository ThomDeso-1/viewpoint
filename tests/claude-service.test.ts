import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installFetchMock, jsonResponse, networkFailure } from './helpers/fetchMock.js';
import { extractReceipt, validateApiKey, ClaudeAPIError } from '../server/services/claude.js';

/**
 * Spec (CONVERSION-PLAN.md "Claude API Extraction Service"):
 *  - validateApiKey succeeds/fails based on whether Claude accepts the key.
 *  - extractReceipt sends each image with the correct media type inferred
 *    from its file extension (.png/.webp/.jpg), so Claude can decode it.
 */
describe('claude service', () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  let tmpDir: string;

  beforeEach(() => {
    fetchMock = installFetchMock();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-claude-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function claudeTextResponse(payload: unknown) {
    return jsonResponse(200, { content: [{ text: JSON.stringify(payload) }] });
  }

  describe('validateApiKey', () => {
    it('resolves for a working key', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [{ text: 'OK' }] }));
      await expect(validateApiKey('sk-good')).resolves.toBeUndefined();
    });

    it('rejects with ClaudeAPIError for a bad key', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'invalid x-api-key' } }));
      await expect(validateApiKey('sk-bad')).rejects.toBeInstanceOf(ClaudeAPIError);
    });

    it('sends the key as the x-api-key header, not Authorization', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [{ text: 'OK' }] }));
      await validateApiKey('sk-header-check');
      const opts = fetchMock.mock.calls[0][1] as RequestInit;
      expect((opts.headers as any)['x-api-key']).toBe('sk-header-check');
    });
  });

  describe('extractReceipt: media type detection', () => {
    function writeFile(name: string, contents = 'bytes'): string {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, contents);
      return p;
    }

    const validPayload = {
      receipt_date: '2024-01-01',
      vendor: 'V',
      items: [],
      summary_description: 's',
      subtotal: 1,
      taxes: [],
      total: 1,
      currency: 'CAD',
      confidence: 'high',
    };

    it('labels a .jpg file as image/jpeg', async () => {
      const file = writeFile('a.jpg');
      fetchMock.mockResolvedValueOnce(claudeTextResponse(validPayload));
      await extractReceipt([file], 'key');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.messages[0].content[0].source.media_type).toBe('image/jpeg');
    });

    it('labels a .png file as image/png', async () => {
      const file = writeFile('a.png');
      fetchMock.mockResolvedValueOnce(claudeTextResponse(validPayload));
      await extractReceipt([file], 'key');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.messages[0].content[0].source.media_type).toBe('image/png');
    });

    it('labels a .webp file as image/webp', async () => {
      const file = writeFile('a.webp');
      fetchMock.mockResolvedValueOnce(claudeTextResponse(validPayload));
      await extractReceipt([file], 'key');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.messages[0].content[0].source.media_type).toBe('image/webp');
    });

    it('sends multiple pages as separate image blocks, followed by the text prompt', async () => {
      const a = writeFile('a.jpg');
      const b = writeFile('b.jpg');
      fetchMock.mockResolvedValueOnce(claudeTextResponse(validPayload));
      await extractReceipt([a, b], 'key');
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      const content = body.messages[0].content;
      expect(content).toHaveLength(3);
      expect(content[0].type).toBe('image');
      expect(content[1].type).toBe('image');
      expect(content[2].type).toBe('text');
    });
  });

  describe('extractReceipt: transport errors', () => {
    it('propagates a network failure as ClaudeAPIError', async () => {
      const file = path.join(tmpDir, 'a.jpg');
      fs.writeFileSync(file, 'bytes');
      fetchMock.mockImplementationOnce(networkFailure());
      await expect(extractReceipt([file], 'key')).rejects.toBeInstanceOf(ClaudeAPIError);
    });
  });
});
