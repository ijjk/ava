const path = require('path');
const debug = require('debug')('ava:pool');
const serializeError = require('../serialize-error');

const runners = new Map();
const accessedRunners = new Map();

global.getRunner = file => {
	accessedRunners.set(file, true);
	return runners.get(file);
};

if (!process.env.NODE_ENV) {
	process.env.NODE_ENV = 'test';
}

// In case the test file imports a different AVA install,
// the presence of this variable allows it to require this one instead
process.env.AVA_PATH = path.resolve(__dirname, '..', '..');

const env = Object.assign({}, process.env);

// Ensure NODE_PATH paths are absolute
if (env.NODE_PATH) {
	env.NODE_PATH = env.NODE_PATH
		.split(path.delimiter)
		.map(x => path.resolve(x))
		.join(path.delimiter);
}

// This is the base TestPool, all Pool
// implementations should be based off of this file
class TestPool {
	constructor(files, options) {
		this.env = env;
		this.files = files;
		this.runners = runners;
		this.initOptions = options;
		this.failFast = options.failFast;
		this.options = options.api.options;
		this.runStatus = options.runStatus;
		this.concurrency = options.concurrency;
		this.accessedRunners = accessedRunners;
		this.precompilation = options.precompilation;
		this.runOnlyExclusive = options.runOnlyExclusive;
	}

	bail() {
		throw new Error('not implemented');
	}

	emitStateChange(evt, file) {
		if (!evt.testFile && file) {
			evt.testFile = file;
		}
		// Debug('emitting', evt)
		// Check if in forked process or not
		if (typeof process.send === 'function') {
			process.send(evt);
		} else {
			this.runStatus.emitStateChange(evt);
		}
	}

	handleExitTest(type, resolve, reject) {
		const {failFast} = this.options;
		const forked = typeof process.send === 'function';

		debug('handleExitTest', type);

		if (failFast && !forked) {
			debug('rejecting test');
			return reject(new Error('clean-exit'));
		}
		debug('resolving test');
		resolve();
	}

	handleError(error, file) {
		const err = error.type ?
			Object.assign(error, {testFile: file}) :
			{
				testFile: file,
				type: 'uncaught-exception',
				err: serializeError('Uncaught exception', true, error)
			};
		debug('handleError', err);
		this.emitStateChange(err, file);
	}

	run() {
		throw new Error('TestPool is not meant to be used directly');
	}
}

module.exports = TestPool;
