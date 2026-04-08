import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

// Mock os to provide consistent machine identity for encryption
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    hostname: vi.fn().mockReturnValue('test-host'),
    userInfo: vi.fn().mockReturnValue({ username: 'test-user' }),
    homedir: actual.homedir,
  };
});

// Mock fs to avoid writing real credential files
const mockFs: Record<string, string> = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path in mockFs),
    readFileSync: vi.fn((path: string) => {
      if (path in mockFs) return mockFs[path];
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      mockFs[path] = data;
    }),
    unlinkSync: vi.fn((path: string) => {
      delete mockFs[path];
    }),
    mkdirSync: vi.fn(),
  };
});

// Must import after mocks
import {
  checkValidationRateLimit,
  deleteApiKey,
  getApiKeyStatus,
  readApiKey,
  storeApiKey,
} from '../credentials.js';

// ── Helpers ──────────────────────────────────────────────────────

const DEPLOY_CREDENTIALS_PATH = join(homedir(), '.mstro', 'deploy-credentials.json');

beforeEach(() => {
  // Clear mock filesystem
  for (const key of Object.keys(mockFs)) {
    delete mockFs[key];
  }
  vi.clearAllMocks();
  // Clear env
  delete process.env.ANTHROPIC_API_KEY;
});

// ── Encryption / Decryption Round Trip ──────────────────────────

describe('AES-256-GCM encryption round trip', () => {
  it('encrypts and decrypts an API key correctly', () => {
    const apiKey = 'sk-ant-api03-test-key-1234567890abcdef';

    storeApiKey(apiKey);

    // Verify the stored data structure
    const storedRaw = mockFs[DEPLOY_CREDENTIALS_PATH];
    expect(storedRaw).toBeDefined();

    const stored = JSON.parse(storedRaw);
    expect(stored.iv).toBeDefined();
    expect(stored.authTag).toBeDefined();
    expect(stored.encrypted).toBeDefined();
    expect(stored.lastFour).toBe('cdef');

    // Verify the encrypted value is NOT the plaintext key
    expect(stored.encrypted).not.toContain(apiKey);

    // Decrypt and verify round trip
    const decrypted = readApiKey();
    expect(decrypted).toBe(apiKey);
  });

  it('uses a 16-byte IV (128 bits) for AES-256-GCM', () => {
    storeApiKey('sk-ant-api03-test-key-xyz');

    const stored = JSON.parse(mockFs[DEPLOY_CREDENTIALS_PATH]);
    const ivBuffer = Buffer.from(stored.iv, 'hex');
    expect(ivBuffer.length).toBe(16);
  });

  it('produces a 16-byte auth tag', () => {
    storeApiKey('sk-ant-api03-test-key-xyz');

    const stored = JSON.parse(mockFs[DEPLOY_CREDENTIALS_PATH]);
    const authTagBuffer = Buffer.from(stored.authTag, 'hex');
    expect(authTagBuffer.length).toBe(16);
  });

  it('generates unique IVs for each encryption', () => {
    storeApiKey('sk-ant-api03-key-1');
    const stored1 = JSON.parse(mockFs[DEPLOY_CREDENTIALS_PATH]);

    storeApiKey('sk-ant-api03-key-2');
    const stored2 = JSON.parse(mockFs[DEPLOY_CREDENTIALS_PATH]);

    expect(stored1.iv).not.toBe(stored2.iv);
  });

  it('returns null when credentials file does not exist', () => {
    const result = readApiKey();
    expect(result).toBeNull();
  });

  it('returns null for corrupted credentials file', () => {
    mockFs[DEPLOY_CREDENTIALS_PATH] = '{ not valid json }}}';
    const result = readApiKey();
    expect(result).toBeNull();
  });

  it('returns null for credential file missing required fields', () => {
    mockFs[DEPLOY_CREDENTIALS_PATH] = JSON.stringify({ iv: 'abc', encrypted: '123' });
    // Missing authTag
    const result = readApiKey();
    expect(result).toBeNull();
  });

  it('detects tampering via auth tag verification', () => {
    storeApiKey('sk-ant-api03-test-key-tamper');

    const stored = JSON.parse(mockFs[DEPLOY_CREDENTIALS_PATH]);
    // Tamper with the encrypted data
    stored.encrypted = stored.encrypted.split('').reverse().join('');
    mockFs[DEPLOY_CREDENTIALS_PATH] = JSON.stringify(stored);

    const result = readApiKey();
    expect(result).toBeNull();
  });

  it('stores lastFour as the last 4 characters of the key', () => {
    const apiKey = 'sk-ant-api03-ends-with-WXYZ';
    const { lastFour } = storeApiKey(apiKey);
    expect(lastFour).toBe('WXYZ');
  });

  it('writes file with mode 0600', () => {
    storeApiKey('sk-ant-api03-test');

    expect(writeFileSync).toHaveBeenCalledWith(
      DEPLOY_CREDENTIALS_PATH,
      expect.any(String),
      { mode: 0o600 },
    );
  });
});

// ── API Key Status ──────────────────────────────────────────────

describe('getApiKeyStatus', () => {
  it('returns env source when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-env-key-abcd';

    const status = getApiKeyStatus();
    expect(status.status).toBe('valid');
    expect(status.lastFour).toBe('abcd');
    expect(status.source).toBe('env');
  });

  it('returns stored source when credentials file exists', () => {
    storeApiKey('sk-ant-api03-stored-key-efgh');

    const status = getApiKeyStatus();
    expect(status.status).toBe('valid');
    expect(status.lastFour).toBe('efgh');
    expect(status.source).toBe('stored');
  });

  it('returns missing when no credentials exist', () => {
    const status = getApiKeyStatus();
    expect(status.status).toBe('missing');
    expect(status.lastFour).toBeUndefined();
  });

  it('env var takes priority over stored credentials', () => {
    storeApiKey('sk-ant-api03-stored-key-1111');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-env-key-2222';

    const status = getApiKeyStatus();
    expect(status.source).toBe('env');
    expect(status.lastFour).toBe('2222');
  });

  it('never includes the full API key in the response', () => {
    storeApiKey('sk-ant-api03-full-secret-key-should-not-appear');

    const status = getApiKeyStatus();
    const statusStr = JSON.stringify(status);
    expect(statusStr).not.toContain('sk-ant-api03');
    expect(statusStr).not.toContain('full-secret-key');
  });
});

// ── Delete API Key ──────────────────────────────────────────────

describe('deleteApiKey', () => {
  it('deletes the credentials file', () => {
    storeApiKey('sk-ant-api03-to-delete');
    expect(readApiKey()).toBeDefined();

    deleteApiKey();
    expect(readApiKey()).toBeNull();
  });

  it('is safe to call when no credentials file exists', () => {
    expect(() => deleteApiKey()).not.toThrow();
  });
});

// ── Rate Limiting ───────────────────────────────────────────────

describe('checkValidationRateLimit', () => {
  // The rate limiter uses a module-level array, so we need to work with
  // timing to test it properly. We'll use vi.useFakeTimers.

  beforeEach(() => {
    vi.useFakeTimers();
    // Advance past any timestamps left by previous tests
    vi.advanceTimersByTime(120_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first 10 attempts', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkValidationRateLimit()).toBe(true);
    }
  });

  it('blocks the 11th attempt within the same minute', () => {
    for (let i = 0; i < 10; i++) {
      checkValidationRateLimit();
    }
    expect(checkValidationRateLimit()).toBe(false);
  });

  it('allows attempts again after the window expires', () => {
    // Exhaust the limit
    for (let i = 0; i < 10; i++) {
      checkValidationRateLimit();
    }
    expect(checkValidationRateLimit()).toBe(false);

    // Advance time past the 60s window
    vi.advanceTimersByTime(60_001);

    // Should be allowed again
    expect(checkValidationRateLimit()).toBe(true);
  });

  it('uses a sliding window — partial expiry allows new attempts', () => {
    // Prune any stale state from prior tests
    checkValidationRateLimit(); // prunes + pushes 1
    // Advance far past to clear that entry too
    vi.advanceTimersByTime(120_000);

    // Now we start fresh. Send 5 attempts at t=base
    for (let i = 0; i < 5; i++) {
      expect(checkValidationRateLimit()).toBe(true);
    }

    // Advance 30s
    vi.advanceTimersByTime(30_000);

    // Send 5 more at t=base+30s (total 10 within window)
    for (let i = 0; i < 5; i++) {
      expect(checkValidationRateLimit()).toBe(true);
    }

    // 11th should fail
    expect(checkValidationRateLimit()).toBe(false);

    // Advance to t=base+60.001s — the first 5 (at t=base) should have expired
    vi.advanceTimersByTime(30_001);

    // Should be able to send again (5 slots freed)
    expect(checkValidationRateLimit()).toBe(true);
  });
});

// ── Token Hash Comparison ───────────────────────────────────────

describe('SHA-256 deploy token hash comparison', () => {
  it('hashes a token with SHA-256 consistently', () => {
    const token = 'dpt_test_token_abc123';
    const hash1 = createHash('sha256').update(token).digest('hex');
    const hash2 = createHash('sha256').update(token).digest('hex');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // 256 bits = 64 hex chars
  });

  it('produces different hashes for different tokens', () => {
    const hash1 = createHash('sha256').update('token-a').digest('hex');
    const hash2 = createHash('sha256').update('token-b').digest('hex');
    expect(hash1).not.toBe(hash2);
  });

  it('validates token by comparing hashes (same logic as ai-broker)', () => {
    const rawToken = `dpt_live_${randomBytes(32).toString('hex')}`;
    const storedHash = createHash('sha256').update(rawToken).digest('hex');

    // Simulate validation: hash incoming token and compare
    const incomingHash = createHash('sha256').update(rawToken).digest('hex');
    expect(incomingHash).toBe(storedHash);

    // Wrong token should not match
    const wrongHash = createHash('sha256').update('wrong-token').digest('hex');
    expect(wrongHash).not.toBe(storedHash);
  });
});
