const Module = require('module');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const nativeRequire = file => require(file);

function updateChildren(parent, child, scan) {
	const children = parent && parent.children;
	if (children && !(scan && children.includes(child))) {
		children.push(child);
	}
}

module.exports = function (file, sandbox) {
	// Minimal reproduction of module
	function SandboxModule(id, parent) {
		this.id = id;
		this.exports = {};
		this.parent = parent;
		updateChildren(parent, this);

		this.filename = null;
		this.loaded = false;
		this.children = [];
	}

	SandboxModule._cache = {};
	SandboxModule.wrap = Module.wrap;
	SandboxModule.dependencies = new Set();
	SandboxModule._nodeModulePaths = Module._nodeModulePaths;
	SandboxModule._resolveFilename = Module._resolveFilename;

	SandboxModule._extensions = {
		// Load js
		'.js'(mod, filename) {
			const content = fs.readFileSync(filename, 'utf8');
			mod._compile(content, filename);
		},
		// Load json
		'.json'(mod, filename) {
			const content = fs.readFileSync(filename, 'utf8');
			mod.exports = JSON.parse(content);
		},
		// Load native module
		'.node'(mod, filename) {
			mod.exports = nativeRequire(filename);
		}
	};

	SandboxModule._load = function (request, parent, isMain) {
		const filename = SandboxModule._resolveFilename(request, parent, isMain);

		const cachedModule = SandboxModule._cache[filename];
		if (cachedModule) {
			updateChildren(parent, cachedModule, true);
			return cachedModule.exports;
		}

		// Built-in modules don't have a path and are the same after resolving e.g. `fs`
		if (filename.indexOf('/') < 0 && filename.indexOf('\\') < 0 && filename === request) {
			return nativeRequire(filename);
		}

		// Don't call updateChildren(), Module constructor already does.
		const module = new SandboxModule(filename, parent);

		if (isMain) {
			process.mainModule = module;
			module.id = '.';
		}

		SandboxModule._cache[filename] = module;

		tryModuleLoad(module, filename);

		return module.exports;
	};

	function tryModuleLoad(module, filename) {
		let threw = true;
		try {
			module.load(filename);
			threw = false;
		} finally {
			if (threw) {
				delete SandboxModule._cache[filename];
			}
		}
	}

	SandboxModule.prototype.load = function (filename) {
		this.filename = filename;
		this.paths = SandboxModule._nodeModulePaths(path.dirname(filename));

		let extension = path.extname(filename) || '.js';
		if (!SandboxModule._extensions[extension]) {
			extension = '.js';
		}

		SandboxModule._extensions[extension](this, filename);
		this.loaded = true;
	};

	SandboxModule.prototype._compile = function (content, filename) {
		const self = this;

		const require = path => {
			if (!path || typeof path !== 'string') {
				throw new Error('require path must be a string');
			}

			path = require.resolve(path);

			// If is a dependency of the main file store it
			if (filename === file) {
				SandboxModule.dependencies.add(path);
			}

			return SandboxModule._load(path, self);
		};

		require.cache = SandboxModule._cache;
		require.extensions = SandboxModule._extensions;

		require.resolve = function (request) {
			return SandboxModule._resolveFilename(request, self);
		};

		const closure = vm.runInContext(SandboxModule.wrap(content), sandbox, {filename});
		closure(self.exports, require, self, filename, path.dirname(filename));
	};

	return SandboxModule;
};
