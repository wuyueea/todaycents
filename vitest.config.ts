import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Thread workers instead of forked child processes: spawning children is
    // blocked in constrained environments (EPERM), threads are not.
    pool: 'threads',
  },
});
