import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Prefer the installed browser locally on Windows. CI uses Playwright's
// pinned Chromium; no browser is downloaded or upgraded by the test command.
let channel = process.env.TODAYCENTS_BROWSER_CHANNEL;
if (!channel && !process.env.CI && process.platform === 'win32') {
  const programs = process.env.ProgramFiles;
  const programsX86 = process.env['ProgramFiles(x86)'];
  if (programs && existsSync(path.join(programs, 'Google/Chrome/Application/chrome.exe'))) channel = 'chrome';
  else if (programsX86 && existsSync(path.join(programsX86, 'Microsoft/Edge/Application/msedge.exe'))) channel = 'msedge';
}

export default defineConfig({
  testDir: './tests/browser', testMatch: '**/*.spec.ts',
  outputDir: './.superpowers/e2e/results',
  forbidOnly: !!process.env.CI, retries: 0, workers: 1,
  timeout: 30_000, reporter: 'list',
  globalTeardown: './tests/browser/teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:4179', browserName: 'chromium',
    channel, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    isMobile: true, hasTouch: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile-320', use: { viewport: { width: 320, height: 760 } } },
    { name: 'mobile-360', use: { viewport: { width: 360, height: 760 } } },
  ],
  webServer: {
    command: 'node --require ./scripts/dsh-vite-shim.cjs tests/browser/server.mjs',
    url: 'http://127.0.0.1:4179/__e2e/ready',
    reuseExistingServer: false, timeout: 60_000,
  },
});
