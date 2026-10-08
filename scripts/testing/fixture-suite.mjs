// A suite that does what it is told, for testing the reporter itself:
//   node fixture-suite.mjs pass | fail | crash | reject
import { createChecks } from '../checks.mjs';

const { check, finish } = createChecks('fixture');
const mode = process.argv[2];
check('it starts', true, 'measured: 1');
if (mode === 'fail') check('a thing that broke', false, 'expected 3, got 2: off by one');
if (mode === 'crash') throw new Error('page.goto: net::ERR_CONNECTION_REFUSED');
if (mode === 'reject') await Promise.reject(new Error('selector timed out'));
finish('all fixture checks passed');
