const serializeError = require('../serialize-error');

const runners = new Map();
const accessedRunners = new Map();

global.getRunner = file => {
	accessedRunners.set(file, true);
	return runners.get(file);
};

// This is the base TestPool, all Pool
// implementations should be based off of this file
class TestPool {
	constructor(files, options) {
		this.files = files;
		this.runners = runners;
		this.initOptions = options;
		this.options = options.api.options;
		this.failFast = options.failFast;
		this.runStatus = options.runStatus;
		this.concurrency = options.concurrency;
		this.accessedRunners = accessedRunners;
		this.precompilation = options.precompilation;
	}

	emitStateChange(evt, file) {
		if (!evt.testFile && file) {
			evt.testFile = file;
		}
		// Check if in forked process or not
		if (typeof process.send === 'function') {
			process.send(evt);
		} else {
			this.runStatus.emitStateChange(evt);
		}
	}

	handleError(file, error, resolve, reject) {
		const err = error.type ?
			Object.assign(error, {testFile: file}) :
			{
				testFile: file,
				type: 'uncaught-exception',
				err: serializeError('Uncaught exception', true, error)
			};

		this.emitStateChange(err);
		if (this.options.failFast) {
			return reject(error);
		}
		resolve();
	}

	run() {
		throw new Error('TestPool is not meant to be used directly');
	}
}

module.exports = TestPool;
