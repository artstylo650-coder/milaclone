'use strict';

// Local acceptance gate: isolated API + real Chromium navigation. Successful
// runs are silent; failures print diagnostics and return a nonzero exit code.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'qa-report');
fs.mkdirSync(reportDir, { recursive: true });
const steps = [
  { name: 'api', args: ['--test', 'test/api.test.js', 'test/comfy.test.js', 'test/translate.test.js', 'test/update.test.js'] },
  { name: 'browser', args: [require.resolve('@playwright/test/cli'), 'test', '--project=chromium'] }
];
const report = { startedAt: new Date().toISOString(), results: [] };
for (const step of steps) {
  const result = spawnSync(process.execPath, step.args, {
    cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : '');
  fs.writeFileSync(path.join(reportDir, step.name + '.log'), output);
  const passed = result.status === 0;
  report.results.push({ name: step.name, passed, exitCode: result.status });
  if (!passed) process.stderr.write(`\nFalha em ${step.name}:\n${output}\n`);
}
report.finishedAt = new Date().toISOString();
report.passed = report.results.every(result => result.passed);
fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(report, null, 2));
if (!report.passed) {
  process.stderr.write('Evidencias: qa-report/ e playwright-report/index.html\n');
  process.exitCode = 1;
}
