// Close our own server before Playwright's process-tree cleanup. In restricted
// Windows environments, the shell-based taskkill fallback can otherwise hang.
export default async function teardown() {
  const response = await fetch('http://127.0.0.1:4179/__e2e/shutdown', {
    method: 'POST',
    headers: { 'X-Test-Run': process.env.TODAYCENTS_E2E_RUN_TOKEN ?? '' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Browser test server did not shut down');
}
