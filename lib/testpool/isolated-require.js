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
	'Error',
	'Symbol'
];

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
	sandbox.getRunner = global.getRunner;
	sandbox.module = new SandboxModule(filename, this);
	sandbox.main = sandbox.module;
	// TODO: might be better to proxy calls to process
	sandbox.process = Object.assign({}, process, {
		exit: () => {
			throw new Error('unexpected-exit');
		},
		chdir: () => {
			throw new Error('unexpected-chdir');
		},
		on: () => {
			// Maybe allow, maybe not
		}
	});

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
