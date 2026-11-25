#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildFourLayerSummary, renderFourLayerMarkdownTable } from './four-layer.mjs';
import { migrateNdjsonToV1 } from './migrator.mjs';
import { runLiveRecord } from './probe-live.mjs';
import { loadReplayFixture, runFourLayerBaselineCorrelation, runTransportReplay } from './replay-runner.mjs';
import { parseAndValidateNdjson } from './schema-validator.mjs';

function printHelp() {
  console.log(`NP-01 AGY Protocol Observatory CLI

Usage:
  node scripts/agy-np/observatory/cli.mjs <command> [options]

Commands:
  record      Capture clean unauthenticated (default), --dry-run, --discover-confirmed,
              --reactive-confirmed --model <id>, or --login-test-profile on Windows.
  validate    Validate an Observatory v1 NDJSON capture against schema & zero-leak rules.
  migrate     Migrate legacy NP-00 probe or agy-1.5.14 stage fixtures to Observatory v1.
  summarize   Produce four-layer comparison table (json | markdown | np03).
  replay      Run a deterministic replay fixture (--mode transport | four-layer).

Examples:
  node scripts/agy-np/observatory/cli.mjs record --dry-run --agy C:\\path\\to\\agy.exe --scratch D:\\HarnessMate\\np00-research
  node scripts/agy-np/observatory/cli.mjs validate --in docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson
  node scripts/agy-np/observatory/cli.mjs summarize --in capture.ndjson --format np03
  node scripts/agy-np/observatory/cli.mjs replay --fixture packages/daemon/tests/fixtures/agy-np/t02-reactive-20s-wake.ndjson
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  const first = args[0];
  const command = first.startsWith('--') ? 'record' : first;
  const subArgs = first.startsWith('--') ? args : args.slice(1);

  if (command === 'record') {
    const res = await runLiveRecord(subArgs);
    if (res && !res.dryRun && !res.validation?.valid) {
      console.error('Capture validation failed:', res.validation?.errors);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'validate') {
    const { values } = parseArgs({
      args: subArgs,
      options: { in: { type: 'string' } },
    });
    if (!values.in) throw new Error('validate requires --in <file>');
    const text = fs.readFileSync(values.in, 'utf8');
    const result = parseAndValidateNdjson(text);
    console.log(
      JSON.stringify(
        {
          file: path.basename(values.in),
          valid: result.valid,
          recordCount: result.recordCount,
          errorCount: result.errors.length,
          leakCount: result.leakFindings.length,
          errors: result.errors.slice(0, 20),
        },
        null,
        2,
      ),
    );
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (command === 'migrate') {
    const { values } = parseArgs({
      args: subArgs,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        scenario: { type: 'string' },
        'capture-id': { type: 'string' },
      },
    });
    if (!values.in) throw new Error('migrate requires --in <file>');
    const text = fs.readFileSync(values.in, 'utf8');
    const migrated = migrateNdjsonToV1(text, {
      scenario: values.scenario,
      captureId: values['capture-id'],
      origin: path.basename(values.in),
    });
    const ndjson = `${migrated.records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    if (values.out) {
      fs.mkdirSync(path.dirname(values.out), { recursive: true });
      fs.writeFileSync(values.out, ndjson, 'utf8');
    } else {
      process.stdout.write(ndjson);
    }
    if (!migrated.validation.valid) {
      console.error('Migration validation failed:', migrated.validation.errors);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'summarize') {
    const { values } = parseArgs({
      args: subArgs,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        format: { type: 'string', default: 'json' },
      },
    });
    if (!values.in) throw new Error('summarize requires --in <file>');
    const text = fs.readFileSync(values.in, 'utf8');
    const parsed = parseAndValidateNdjson(text);
    if (!parsed.valid) {
      throw new Error(`Input capture failed validation: ${parsed.errors.slice(0, 5).join('; ')}`);
    }
    const summary = buildFourLayerSummary(parsed.records);
    let output;
    if (values.format === 'markdown') {
      output = renderFourLayerMarkdownTable(summary);
    } else if (values.format === 'np03') {
      output = `${JSON.stringify(summary.np03DiagnosticInput, null, 2)}\n`;
    } else {
      output = `${JSON.stringify(summary, null, 2)}\n`;
    }
    if (values.out) {
      fs.mkdirSync(path.dirname(values.out), { recursive: true });
      fs.writeFileSync(values.out, output, 'utf8');
    } else {
      process.stdout.write(output);
    }
    return;
  }

  if (command === 'replay') {
    const { values } = parseArgs({
      args: subArgs,
      options: {
        fixture: { type: 'string' },
        mode: { type: 'string', default: 'transport' },
        out: { type: 'string' },
        'summary-out': { type: 'string' },
      },
    });
    let res;
    if (values.mode === 'four-layer') {
      res = await runFourLayerBaselineCorrelation();
    } else {
      if (!values.fixture) throw new Error('replay --mode transport requires --fixture <file>');
      const loaded = loadReplayFixture(values.fixture);
      res = await runTransportReplay(loaded);
    }
    if (values.out) {
      fs.mkdirSync(path.dirname(values.out), { recursive: true });
      fs.writeFileSync(values.out, `${res.records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    }
    if (values['summary-out']) {
      fs.mkdirSync(path.dirname(values['summary-out']), { recursive: true });
      fs.writeFileSync(values['summary-out'], `${JSON.stringify(res.summary, null, 2)}\n`, 'utf8');
    }
    console.log(
      JSON.stringify(
        {
          mode: values.mode,
          scenarioId: res.scenarioId ?? res.summary.scenario,
          recordCount: res.records.length,
          valid: res.validation.valid,
          verdictPassed: res.verdict ? res.verdict.passed : true,
          copyableDiagnosticCode: res.summary.np03DiagnosticInput.copyableDiagnosticCode,
          anomalies: res.summary.anomalies,
        },
        null,
        2,
      ),
    );
    if (!res.validation.valid || (res.verdict && !res.verdict.passed)) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command "${command}". Use --help for usage.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
