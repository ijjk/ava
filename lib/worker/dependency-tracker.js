'use strict';
/* eslint-disable node/no-deprecated-api */
let send;

const seenDependencies = new Set();
let newDependencies = [];
function flush() {
	if (newDependencies.length === 0) {
		return;
	}

	send({type: 'dependencies', dependencies: newDependencies});
	newDependencies = [];
}

exports.flush = flush;

function track(filename) {
	if (seenDependencies.has(filename)) {
		return;
	}

	if (newDependencies.length === 0) {
		process.nextTick(flush);
	}

	seenDependencies.add(filename);
	newDependencies.push(filename);
}

exports.track = track;

const wrappedHandlers = new Map();
function install(testPath, emitChange) {
	send = emitChange;

	for (const ext of Object.keys(require.extensions)) {
		wrappedHandlers.set(ext, require.extensions[ext]);

		require.extensions[ext] = (module, filename) => {
			if (filename !== testPath) {
				track(filename);
			}

			wrappedHandlers.get(ext)(module, filename);
		};
	}
}

exports.install = install;

function uninstall() {
	[...wrappedHandlers.keys()].forEach(ext => {
		require.extensions[ext] = wrappedHandlers.get(ext);
	});
}

exports.uninstall = uninstall;
