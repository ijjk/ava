const path = require('path');
const vm = require('vm');

// Make global methods/objects available in sandbox
const sandboxGlobals = [
	'setTimeout',
	'clearTimeout',
	'setInterval',
	'clearInterval',
	'setImmediate',
	'Buffer',
	'console',
	'getRunner',
	'events',
	'Error',
	'Symbol',
];

/*
	TODO: instead of trying to share instances of Object, Array, etc
	create runner inside of vm context and call external methods (TestPool.emitStateChange)
	to update the external context. 

	This way instanceOf should work fine in ../assert.js

	Will still need to share setTimeout, setInterval, etc
	Will not need to share Error, Symbol, and getRunner

	getRunner will be moved inside of the vm context (we shouldn't have to store them in a set anymore!)
 */


/**
 * Require a file in an isolated context, all sub-requires are isolated also
 *
 * @param { string } file - file to require in an isolated context
 * @param { string } preScript - JavaScript to run before requiring file
 * @returns { SandboxModule } - the sandbox-module used for isolation
 */
const isolatedRequire = (file, preScript = '') => {
	const filename = require.resolve(file);
	const dirname = path.dirname(filename);
	const sandbox = {};
	const SandboxModule = require('./sandbox-module')(file, sandbox);

	sandboxGlobals.forEach(key => {
		sandbox[key] = global[key];
	});

	sandbox.exports = {};
	sandbox.global = sandbox;
	sandbox.__dirname = dirname;
	sandbox.__filename = filename;
	sandbox.module = new SandboxModule(filename, this);
	sandbox.main = sandbox.module;
	sandbox.process = process
	sandbox.process.exit = () => {
		throw new Error('unexpected-exit');
	}
	sandbox.process.abort = sandbox.process.exit

	sandbox.require = path => {
		if (!path || typeof path !== 'string') {
			throw new Error('require path must be a string');
		}

		path = sandbox.require.resolve(path);
		return SandboxModule._load(path);
	};

	sandbox.require.main = sandbox.module;
	sandbox.require.resolve = require.resolve;
	sandbox.require.cache = SandboxModule._cache;
	sandbox.require.extensions = SandboxModule._extensions;

	vm.createContext(sandbox);

	vm.runInContext(`
    ${preScript}
    require('${filename}');
  `, sandbox, {filename});

	return SandboxModule;
};

module.exports = isolatedRequire;
