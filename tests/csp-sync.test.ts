import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * CSP 双源同步检查：
 * 确保 vite.config.ts 中的 CSP_PROFILES 与 HTML 源文件中的 meta tag 保持一致。
 * 如果测试失败，说明有人改了 CSP_PROFILES 但忘了同步 HTML 源文件（或反之）。
 */

// 从 vite.config.ts 源码中提取 CSP_PROFILES（不 import，避免引入 Vite 依赖）
function extractCspProfiles(): Record<string, string> {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'vite.config.ts'), 'utf-8');
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

function renderRuntimeConnectionCsp(storageValue: unknown): string {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'desktop', 'src', 'modules', 'connection-csp.js'),
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
  const htmlDir = path.resolve(__dirname, '..', 'desktop', 'src');

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
    expect(runtimeCsp).toContain('activeServerConnectionId');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
  });

  it('settings window uses the same dynamic scoped connection CSP as the desktop index', () => {
    const html = fs.readFileSync(path.join(htmlDir, 'settings.html'), 'utf-8');
    const runtimeCsp = fs.readFileSync(path.join(htmlDir, 'modules', 'connection-csp.js'), 'utf-8');

    expect(html).toContain('modules/connection-csp.js');
    expect(extractHtmlCsp(path.join(htmlDir, 'settings.html'))).toBeNull();
    expect(runtimeCsp).toContain('activeServerConnectionId');
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttp:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\sws:(?:\s|;|$)/);
    expect(runtimeCsp).not.toMatch(/connect-src[^;]*\swss:(?:\s|;|$)/);
  });

  it('runtime desktop CSP allows active remote resource origins for image and media rendering', () => {
    const csp = parseCsp(renderRuntimeConnectionCsp({
      activeServerConnectionId: 'lan:remote:studio',
      serverConnections: {
        'lan:remote:studio': {
          connectionId: 'lan:remote:studio',
          kind: 'lan',
          baseUrl: 'http://100.125.173.118:14500',
          wsUrl: 'ws://100.125.173.118:14500',
        },
      },
    }));

    expect(csp['connect-src']).toContain('http://100.125.173.118:14500');
    expect(csp['connect-src']).toContain('ws://100.125.173.118:14500');
    expect(csp['img-src']).toContain('http://100.125.173.118:14500');
    expect(csp['media-src']).toContain('http://100.125.173.118:14500');
    expect(csp['img-src']).not.toContain('http:');
    expect(csp['media-src']).not.toContain('http:');
  });
});
