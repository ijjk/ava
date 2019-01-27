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
	'events'
];

/**
 * Require a file in an isolated context, all sub-requires are isolated also
 *
 * @param { string } file - file to require in an isolated context
 * @param { string } preScript - JavaScript to run before requiring file
 * @param { string } postScript - JavaScript to run after requiring file
 * @param { object } globals - object with globals to expose in sandbox
 * @returns { SandboxModule } - the sandbox-module used for isolation
 */
const isolatedRequire = (file, preScript = '', postScript = '', globals = {}) => {
	const filename = require.resolve(file);
	const dirname = path.dirname(filename);
	const sandbox = Object.assign({}, globals);
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
	sandbox.process = process;
	sandbox.process.exit = () => {
		throw new Error('unexpected-exit');
	};

	sandbox.process.abort = sandbox.process.exit;

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
    require(__filename);
		${postScript}
  `, sandbox, {filename});

	return SandboxModule.dependencies;
};

module.exports = isolatedRequire;
