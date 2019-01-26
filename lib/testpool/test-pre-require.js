/* global _ava_ */
// this is run in the vm context before requiring the test file
(function () {
	const {
		file,
		resolve,
		options,
		failTypes,
		precompiled,
		handleError,
		handleExitTest,
		emitStateChange,
		runOnlyExclusive,
		uncaughtListeners,
		unhandledListeners,
		allListenerCleanUps
	} = _ava_;

	require('../chalk').set({});
	const Runner = require('../runner');
	const debug = require('debug')('ava:pool');
	const nowAndTimers = require('../now-and-timers');
	const serializeError = require('../serialize-error');
	const sourceMapSupport = require('source-map-support');
	const currentlyUnhandled = require('currently-unhandled')();

	_ava_.runnerAccessed = false;

	const runner = new Runner({
		file,
		match: options.match,
		serial: options.serial,
		failFast: options.failFast,
		projectDir: options.projectDir,
		snapshotDir: options.snapshotDir,
		runOnlyExclusive,
		updateSnapshots: options.updateSnapshots,
		failWithoutAssertions: options.failWithoutAssertions
	});

	global.getRunner = () => {
		_ava_.runnerAccessed = true;
		return runner;
	};

	runner.on('stateChange', evt => {
		emitStateChange(evt);

		if (options.failFast && failTypes[evt.type]) {
			handleExitTest(evt.type);
		}
	});

	runner.on('finish', () => {
		debug('finished ' + file);

		const touchedFiles = runner.saveSnapshotState();
		emitStateChange({type: 'touched-files', files: touchedFiles || []});
		emitStateChange({type: 'worker-finished'});

		nowAndTimers.setImmediate(() => {
			currentlyUnhandled()
				.filter(rejection => !attributedRejections.has(rejection.promise))
				.forEach(rejection => {
					emitStateChange({type: 'unhandled-rejection', err: serializeError('Unhandled rejection', true, rejection.reason)});
				});
			resolve();
		});
	});

	runner.on('error', error => {
		debug('runner error', error);
		handleError(error);
	});

	// End of runner set up

	const handleException = err => {
		let stackHasFile = err.stack.indexOf(file) > -1;
		// Try checking sourceMap sources
		if (stackHasFile === false) {
			const sourceMap = sourceMapSupport.retrieveSourceMap(file);
			if (sourceMap) {
				const {sources} = JSON.parse(sourceMap.map);
				stackHasFile = sources && sources.some(source => err.stack.indexOf(source) > -1);
			}
		}

		if (stackHasFile === false || runner.attributeLeakedError(err)) {
			return;
		}

		handleError(err);
	};

	const attributedRejections = new Set();

	const handleRejection = (reason, promise) => {
		if (runner.attributeLeakedError(reason)) {
			attributedRejections.add(promise);
		}
	};

	uncaughtListeners.add(handleException);
	unhandledListeners.add(handleRejection);

	const cleanUpListeners = () => {
		uncaughtListeners.delete(handleException);
		unhandledListeners.delete(handleRejection);
		allListenerCleanUps.delete(cleanUpListeners);
	};

	allListenerCleanUps.add(cleanUpListeners);

	// End of error handling

	const precompilerHook = require('../worker/precompiler-hook');
	precompilerHook.install(precompiled);

	for (const mod of (options.require || [])) {
		const required = require(mod);
		try {
			if (required[Symbol.for('esm\u200D:package')]) {
				require = required(module); // eslint-disable-line no-global-assign
			}
		} catch (_) {}
	}
})();
