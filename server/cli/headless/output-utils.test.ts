import { describe, expect, it } from 'vitest';
import {
  detectErrorInStderr,
  estimateTokensFromOutput,
  extractCleanOutput,
  extractModifiedFiles,
} from './output-utils.js';

// ========== extractCleanOutput ==========

describe('extractCleanOutput', () => {
  it('filters out JSON lines with "type" field', () => {
    const input = [
      '{"type": "system", "data": "init"}',
      'Hello world',
      '{"type": "assistant", "text": "hi"}',
      'Some output',
    ].join('\n');
    expect(extractCleanOutput(input)).toBe('Hello world\nSome output');
  });

  it('strips ANSI color codes', () => {
    const input = '\x1b[32mgreen text\x1b[0m and \x1b[1;31mred bold\x1b[0m';
    expect(extractCleanOutput(input)).toBe('green text and red bold');
  });

  it('normalizes CRLF to LF', () => {
    const input = 'line1\r\nline2\r\nline3';
    expect(extractCleanOutput(input)).toBe('line1\nline2\nline3');
  });

  it('trims whitespace', () => {
    const input = '  \n  Hello  \n  ';
    expect(extractCleanOutput(input)).toBe('Hello');
  });

  it('filters empty lines', () => {
    const input = 'line1\n\n\nline2';
    expect(extractCleanOutput(input)).toBe('line1\nline2');
  });

  it('returns empty string for all-JSON input', () => {
    const input = '{"type": "system"}\n{"type": "result"}';
    expect(extractCleanOutput(input)).toBe('');
  });

  it('handles combined ANSI + JSON + CRLF', () => {
    const input = '{"type": "system"}\r\n\x1b[33mwarning\x1b[0m\r\n{"type": "result"}';
    expect(extractCleanOutput(input)).toBe('warning');
  });
});

// ========== estimateTokensFromOutput ==========

describe('estimateTokensFromOutput', () => {
  it('estimates tokens as length / 4', () => {
    expect(estimateTokensFromOutput('12345678')).toBe(2);
    expect(estimateTokensFromOutput('1234')).toBe(1);
  });

  it('floors the result', () => {
    expect(estimateTokensFromOutput('12345')).toBe(1); // 5/4 = 1.25 → 1
    expect(estimateTokensFromOutput('123')).toBe(0);   // 3/4 = 0.75 → 0
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokensFromOutput('')).toBe(0);
  });
});

// ========== extractModifiedFiles ==========

describe('extractModifiedFiles', () => {
  it('extracts files from "wrote" pattern', () => {
    const output = 'wrote file "src/index.ts" successfully';
    expect(extractModifiedFiles(output)).toContain('src/index.ts');
  });

  it('extracts files from "modified" pattern', () => {
    const output = 'modified utils.js in place';
    expect(extractModifiedFiles(output)).toContain('utils.js');
  });

  it('extracts files from "created" pattern', () => {
    const output = "created file 'new-file.tsx'";
    expect(extractModifiedFiles(output)).toContain('new-file.tsx');
  });

  it('extracts files from "edited" pattern', () => {
    const output = 'edited config.json';
    expect(extractModifiedFiles(output)).toContain('config.json');
  });

  it('deduplicates files', () => {
    const output = 'wrote src/index.ts\nmodified src/index.ts';
    const files = extractModifiedFiles(output);
    expect(files.filter(f => f === 'src/index.ts')).toHaveLength(1);
  });

  it('returns empty array when no files found', () => {
    expect(extractModifiedFiles('no files mentioned here')).toEqual([]);
  });

  it('extracts multiple different files', () => {
    const output = 'wrote src/a.ts\ncreated src/b.ts\nedited src/c.ts';
    const files = extractModifiedFiles(output);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.ts');
    expect(files).toContain('src/c.ts');
  });
});

// ========== detectErrorInStderr ==========

describe('detectErrorInStderr', () => {
  it('detects auth errors', () => {
    const result = detectErrorInStderr('Error: not logged in to Claude');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('AUTH_REQUIRED');
  });

  it('detects session expired', () => {
    const result = detectErrorInStderr('Your session has expired, please re-authenticate');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('AUTH_REQUIRED');
  });

  it('detects account not found', () => {
    const result = detectErrorInStderr('account not found for this user');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('ACCOUNT_NOT_FOUND');
  });

  it('detects API key errors', () => {
    const result = detectErrorInStderr('invalid api key provided');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('API_KEY_INVALID');
  });

  it('detects quota exceeded', () => {
    const result = detectErrorInStderr('quota exceeded for your subscription');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('QUOTA_EXCEEDED');
  });

  it('detects billing issues', () => {
    const result = detectErrorInStderr('payment required to continue');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('QUOTA_EXCEEDED');
  });

  it('detects rate limiting', () => {
    const result = detectErrorInStderr('rate limit exceeded, retry after 30s');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('RATE_LIMITED');
  });

  it('detects 429 status', () => {
    const result = detectErrorInStderr('HTTP 429 too many requests');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('RATE_LIMITED');
  });

  it('detects network errors', () => {
    const result = detectErrorInStderr('ECONNREFUSED 127.0.0.1:443');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('NETWORK_ERROR');
  });

  it('detects DNS failures', () => {
    const result = detectErrorInStderr('ENOTFOUND api.anthropic.com');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('NETWORK_ERROR');
  });

  it('detects SSL errors', () => {
    const result = detectErrorInStderr('CERT_HAS_EXPIRED for api.example.com');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('SSL_ERROR');
  });

  it('detects service unavailable', () => {
    const result = detectErrorInStderr('service unavailable, try again later');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('SERVICE_UNAVAILABLE');
  });

  it('detects 503 status', () => {
    const result = detectErrorInStderr('HTTP 503 from upstream');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('SERVICE_UNAVAILABLE');
  });

  it('detects internal errors', () => {
    const result = detectErrorInStderr('internal server error occurred');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('INTERNAL_ERROR');
  });

  it('detects context too long', () => {
    const result = detectErrorInStderr('context too long, exceeds 200k tokens');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('CONTEXT_TOO_LONG');
  });

  it('detects session not found', () => {
    const result = detectErrorInStderr('session not found, please create a new one');
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('returns null for non-matching stderr', () => {
    expect(detectErrorInStderr('Processing file...')).toBeNull();
    expect(detectErrorInStderr('Warning: deprecated API usage')).toBeNull();
    expect(detectErrorInStderr('')).toBeNull();
  });

  it('returns user-friendly messages', () => {
    const result = detectErrorInStderr('not logged in');
    expect(result).not.toBeNull();
    expect(result!.message).toContain('authentication');
    // Should not expose raw error
    expect(result!.message).not.toContain('not logged in');
  });
});
