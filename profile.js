'use strict';

// Iron-node does not work with forked processes
// This cli command will run a single file in the current process.
// Intended to be used with iron-node for profiling purposes.

const meow = require('meow');
const debug = require('debug')('ava');
const importLocal = require('import-local');

// Define a minimal set of options from the main CLI
const cli = meow(`
	Usage
	  $ iron-node node_modules/ava/profile.js <test-file>

	Options
	  --fail-fast   Stop after first test failure
	  --serial, -s  Run tests serially
		
`, {
	string: [
		'_'
	],
	boolean: [
		'fail-fast',
		'verbose',
		'serial',
		'tap'
	],
	alias: {
		s: 'serial'
	}
});

if (cli.input.length === 0) {
	throw new Error('Specify a test file');
}

// Prefer the local installation of AVA
if (importLocal(__filename)) {
	debug('Using local install of AVA');
} else {
	require('./lib/cli').run({fork: false});
}
