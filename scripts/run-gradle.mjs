import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep Gradle's user home and the Android user home (adb keys, debug keystore,
// analytics) inside the repository. Both default to %USERPROFILE% on Windows,
// which is outside the DSH workspace sandbox.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const gradleHome = path.join(root, '.gradle-home');
const androidUserHome = path.join(root, '.android');

fs.mkdirSync(gradleHome, { recursive: true });
fs.mkdirSync(androidUserHome, { recursive: true });

const env = {
  ...process.env,
  GRADLE_USER_HOME: gradleHome,
  ANDROID_USER_HOME: androidUserHome,
};

const args = process.argv.slice(2);

function quoteForCmd(value) {
  return /[ \t"^&|<>]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

let child;
if (process.platform === 'win32') {
  const command = ['gradlew.bat', ...args.map(quoteForCmd)].join(' ');
  child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: androidDir,
    env,
    stdio: 'inherit',
  });
} else {
  child = spawn(path.join(androidDir, 'gradlew'), args, {
    cwd: androidDir,
    env,
    stdio: 'inherit',
  });
}

child.on('error', (error) => {
  console.error(`无法启动 Gradle：${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Gradle 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
