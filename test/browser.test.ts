import { describe, expect, it } from 'vitest';

import { browserCommand } from '../src/auth/loopback.js';

const OAUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com' +
  '&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&response_type=code&scope=openid+email' +
  '&state=xyz&access_type=offline&prompt=consent';

describe('opening the browser', () => {
  it('passes the whole URL as one argument on Windows', () => {
    const { command, args } = browserCommand('win32', OAUTH_URL);
    // `cmd /c start` splits on `&`, so the browser received only `?client_id=...`
    // and Google rejected the request for a missing `response_type`.
    expect(command).not.toBe('cmd');
    expect(args).toContain(OAUTH_URL);
    expect(args.some((a) => a.includes('&'))).toBe(true);
  });

  it('keeps every OAuth parameter intact', () => {
    const { args } = browserCommand('win32', OAUTH_URL);
    const passed = args.find((a) => a.startsWith('https://'))!;
    const params = new URL(passed).searchParams;
    for (const key of ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']) {
      expect(params.get(key), `${key} was lost`).toBeTruthy();
    }
    expect(params.get('response_type')).toBe('code');
  });

  it('uses the native opener on macOS and Linux', () => {
    expect(browserCommand('darwin', OAUTH_URL)).toEqual({ command: 'open', args: [OAUTH_URL] });
    expect(browserCommand('linux', OAUTH_URL)).toEqual({ command: 'xdg-open', args: [OAUTH_URL] });
  });
});
