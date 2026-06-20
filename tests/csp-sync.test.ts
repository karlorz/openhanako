import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as vm from 'node:vm';

/**
 * CSP 双源同步检查：
 * 确保 vite.config.ts 中的 CSP_PROFILES 与 HTML 源文件中的 meta tag 保持一致。
 * 如果测试失败，说明有人改了 CSP_PROFILES 但忘了同步 HTML 源文件（或反之）。
 */

type EnvLike = Record<string, string | undefined>;
type CspConnectionFixture = {
  baseUrl: string;
  wsUrl: string;
};

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_REMOTE_URL = 'http://100.125.173.118:14500';
const DEFAULT_SAVED_REMOTE_URL = 'http://192.168.1.9:14500';

// 从 vite.config.ts 源码中提取 CSP_PROFILES（不 import，避免引入 Vite 依赖）
function extractCspProfiles(): Record<string, string> {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf-8');
  const profiles: Record<string, string> = {};

  // 匹配 'filename.html': "csp-value" 或 'filename.html':\n    "csp-value"
  const re = /'([^']+\.html)':\s*\n?\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    profiles[m[1]] = m[2];
  }
  return profiles;
}

// 从 HTML 文件中提取 CSP content 属性值
function extractHtmlCsp(htmlPath: string): string | null {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/s);
  return m ? m[1] : null;
}

// 标准化 CSP：去除末尾分号，排序指令
function normalizeCsp(csp: string): string {
  return csp
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .sort()
    .join('; ');
}

function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out[parts[0]] = parts.slice(1);
  }
  return out;
}

function parseDotEnv(content: string): EnvLike {
  const out: EnvLike = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readRootDotEnv(): string {
  try {
    return fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function envValue(env: EnvLike, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${url.protocol}//${url.host}`;
}

function resolveConnectionFixture(env: EnvLike, prefix: string, defaultUrl: string): CspConnectionFixture {
  const baseUrl = envValue(env, `${prefix}_URL`) ||
    envValue(env, `${prefix}_BASE_URL`) ||
    (envValue(env, `${prefix}_IP`)
      ? `${envValue(env, `${prefix}_PROTOCOL`) || 'http'}://${envValue(env, `${prefix}_IP`)}:${envValue(env, `${prefix}_PORT`) || '14500'}`
      : defaultUrl);

  return {
    baseUrl,
    wsUrl: envValue(env, `${prefix}_WS_URL`) || deriveWsUrl(baseUrl),
  };
}

function resolveCspFixtureConfig(env: EnvLike = process.env, dotEnvText = readRootDotEnv()) {
  const mergedEnv = { ...parseDotEnv(dotEnvText), ...env };
  return {
    remote: resolveConnectionFixture(mergedEnv, 'HANA_CSP_TEST_REMOTE', DEFAULT_REMOTE_URL),
    savedRemote: resolveConnectionFixture(mergedEnv, 'HANA_CSP_TEST_SAVED_REMOTE', DEFAULT_SAVED_REMOTE_URL),
  };
}

function renderRuntimeConnectionCsp(storageValue: unknown): string {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'desktop', 'src', 'modules', 'connection-csp.js'),
    'utf-8',
  );
  let written = '';
  const context = vm.createContext({
    URL,
    localStorage: {
      getItem: (key: string) => key === 'hana-server-connections-v1'
        ? JSON.stringify(storageValue)
        : null,
    },
    window: {
      location: {
        host: '',
        hostname: '',
      },
    },
    document: {
      write: (html: string) => {
        written += html;
      },
    },
  });
  vm.runInContext(src, context);
  const match = written.match(/content="([^"]+)"/);
  if (!match) throw new Error(`CSP meta not written: ${written}`);
  return match[1].replace(/&quot;/g, '"');
}

describe('CSP sync', () => {
  const profiles = extractCspProfiles();
  const htmlDir = path.join(ROOT_DIR, 'desktop', 'src');
  const cspFixture = resolveCspFixtureConfig();

  it('should have extracted all 8 profiles', () => {
    expect(Object.keys(profiles)).toHaveLength(8);
  });

  for (const [filename, profileCsp] of Object.entries(profiles)) {
    it(`${filename}: HTML source matches CSP_PROFILES`, () => {
      if (filename === 'index.html' || filename === 'settings.html') {
        const html = fs.readFileSync(path.join(htmlDir, filename), 'utf-8');
        expect(html).toContain('modules/connection-csp.js');
        expect(extractHtmlCsp(path.join(htmlDir, filename))).toBeNull();
        return;
      }
      const htmlPath = path.join(htmlDir, filename);
      const htmlCsp = extractHtmlCsp(htmlPath);
      expect(htmlCsp).not.toBeNull();
      expect(normalizeCsp(htmlCsp!)).toBe(normalizeCsp(profileCsp));
    });
  }

  it('desktop index CSP is not widened to all remote origins', () => {
    const indexCsp = profiles['index.html'];
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(indexCsp).toBeTruthy();
    expect(indexCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
    expect(runtimeCsp).toContain('serverConnections');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
    const csp = parseCsp(renderRuntimeConnectionCsp({
      activeServerConnectionId: 'lan:remote:studio',
      serverConnections: {
        'lan:remote:studio': {
          connectionId: 'lan:remote:studio',
          kind: 'lan',
          baseUrl: cspFixture.remote.baseUrl,
          wsUrl: cspFixture.remote.wsUrl,
        },
      },
    }));

    expect(csp['connect-src']).toContain(cspFixture.remote.baseUrl);
    expect(csp['connect-src']).toContain(cspFixture.remote.wsUrl);
    expect(csp['img-src']).toContain(cspFixture.remote.baseUrl);
    expect(csp['media-src']).toContain(cspFixture.remote.baseUrl);
    expect(csp['img-src']).not.toContain('http:');
    expect(csp['media-src']).not.toContain('http:');

    const savedCsp = parseCsp(renderRuntimeConnectionCsp({
      schemaVersion: 1,
      activeServerConnectionId: null,
      serverConnections: {
        'lan:node:studio': {
          connectionId: 'lan:node:studio',
          kind: 'lan',
          baseUrl: cspFixture.savedRemote.baseUrl,
          wsUrl: cspFixture.savedRemote.wsUrl,
        },
      },
    }));

    expect(savedCsp['connect-src']).toContain(cspFixture.savedRemote.baseUrl);
    expect(savedCsp['connect-src']).toContain(cspFixture.savedRemote.wsUrl);
    expect(savedCsp['img-src']).toContain(cspFixture.savedRemote.baseUrl);
    expect(savedCsp['media-src']).toContain(cspFixture.savedRemote.baseUrl);

    const envFixture = resolveCspFixtureConfig({}, [
      'HANA_CSP_TEST_REMOTE_URL=http://10.0.0.2:18080',
      'HANA_CSP_TEST_REMOTE_WS_URL=ws://10.0.0.2:18080',
      'HANA_CSP_TEST_SAVED_REMOTE_URL=http://10.0.0.3:19090',
      'HANA_CSP_TEST_SAVED_REMOTE_WS_URL=ws://10.0.0.3:19090',
    ].join('\n'));

    expect(envFixture.remote).toEqual({
      baseUrl: 'http://10.0.0.2:18080',
      wsUrl: 'ws://10.0.0.2:18080',
    });
    expect(envFixture.savedRemote).toEqual({
      baseUrl: 'http://10.0.0.3:19090',
      wsUrl: 'ws://10.0.0.3:19090',
    });

    const ipFixture = resolveCspFixtureConfig({}, [
      'HANA_CSP_TEST_REMOTE_IP=10.0.0.4',
      'HANA_CSP_TEST_REMOTE_PORT=17070',
    ].join('\n'));

    expect(ipFixture.remote).toEqual({
      baseUrl: 'http://10.0.0.4:17070',
      wsUrl: 'ws://10.0.0.4:17070',
    });
  });

  it('desktop index CSP allows local PDF iframe sources without widening connections', () => {
    const indexCsp = profiles['index.html'];
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(indexCsp).toMatch(/frame-src[^;]*\sfile:(?:\s|;|$)/);
    expect(runtimeCsp).toMatch(/"frame-src":\s*\[[^\]]*"file:"/s);
    expect(indexCsp).not.toMatch(/connect-src[^;]*\sfile:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/"connect-src":\s*\[[^\]]*"file:"/s);
  });

  it('settings window uses the same dynamic scoped connection CSP as the desktop index', () => {
    const html = fs.readFileSync(path.join(htmlDir, 'settings.html'), 'utf-8');
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(html).toContain('modules/connection-csp.js');
    expect(extractHtmlCsp(path.join(htmlDir, 'settings.html'))).toBeNull();
    expect(runtimeCsp).toContain('serverConnections');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
  });

  it('dynamic desktop CSP keeps saved remote origins available after active selection is cleared', () => {
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');
    let written = '';
    const storage = {
      'hana-server-connections-v1': JSON.stringify({
        schemaVersion: 1,
        activeServerConnectionId: null,
        serverConnections: {
          'lan:node:studio': {
            connectionId: 'lan:node:studio',
            kind: 'lan',
            baseUrl: 'http://192.168.1.9:14500',
            wsUrl: 'ws://192.168.1.9:14500',
          },
        },
      }),
    };
    vm.runInNewContext(runtimeCsp, {
      URL,
      window: {
        location: {
          host: '127.0.0.1:5173',
          hostname: '127.0.0.1',
        },
      },
      localStorage: {
        getItem(key: string) {
          return storage[key] || null;
        },
      },
      document: {
        write(value: string) {
          written += value;
        },
      },
    });

    expect(written).toContain('http://192.168.1.9:14500');
    expect(written).toContain('ws://192.168.1.9:14500');
  });
});
