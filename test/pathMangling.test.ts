import { afterEach, describe, expect, it } from 'vitest';

import { unmanglePath } from '../src/cli/args.js';

const original = { platform: process.platform, MSYSTEM: process.env.MSYSTEM, EXEPATH: process.env.EXEPATH };

function pretendGitBash(exePath = 'C:\\Program Files\\Git\\bin') {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.MSYSTEM = 'MINGW64';
  process.env.EXEPATH = exePath;
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: original.platform, configurable: true });
  if (original.MSYSTEM === undefined) delete process.env.MSYSTEM;
  else process.env.MSYSTEM = original.MSYSTEM;
  if (original.EXEPATH === undefined) delete process.env.EXEPATH;
  else process.env.EXEPATH = original.EXEPATH;
});

describe('Git Bash path mangling', () => {
  it('recovers a path MSYS rewrote into a Windows one', () => {
    pretendGitBash();
    // What `dv api github /user` actually delivers to the process on Git Bash.
    expect(unmanglePath('C:/Program Files/Git/user')).toBe('/user');
  });

  it('recovers a multi-segment path', () => {
    pretendGitBash();
    expect(unmanglePath('C:/Program Files/Git/repos/owner/name/issues')).toBe('/repos/owner/name/issues');
  });

  it('recovers a bare slash', () => {
    pretendGitBash();
    expect(unmanglePath('C:/Program Files/Git')).toBe('/');
  });

  it('handles backslash separators', () => {
    pretendGitBash();
    expect(unmanglePath('C:\\Program Files\\Git\\v1\\users')).toBe('/v1/users');
  });

  it('is case-insensitive, as Windows paths are', () => {
    pretendGitBash();
    expect(unmanglePath('c:/program files/git/user')).toBe('/user');
  });

  it('leaves an already-correct path alone', () => {
    pretendGitBash();
    expect(unmanglePath('/user')).toBe('/user');
    expect(unmanglePath('/repos/a/b')).toBe('/repos/a/b');
  });

  it('leaves an unrelated Windows path alone', () => {
    pretendGitBash();
    // Not under the Git root, so it was never mangled — do not invent a change.
    expect(unmanglePath('C:/Users/me/file.txt')).toBe('C:/Users/me/file.txt');
  });

  it('does nothing outside Git Bash', () => {
    // On a normal shell an argument that looks like this really is a Windows path.
    delete process.env.MSYSTEM;
    expect(unmanglePath('C:/Program Files/Git/user')).toBe('C:/Program Files/Git/user');
  });

  it('does nothing when EXEPATH is absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.MSYSTEM = 'MINGW64';
    delete process.env.EXEPATH;
    expect(unmanglePath('C:/Program Files/Git/user')).toBe('C:/Program Files/Git/user');
  });

  it('handles a Git installed somewhere else', () => {
    pretendGitBash('D:\\tools\\Git\\bin');
    expect(unmanglePath('D:/tools/Git/v1/me')).toBe('/v1/me');
  });
});
