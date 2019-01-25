const Module = require('module');
const path = require('path');
const vm = require('vm');

/**
 * Require a file in an isolated context, all sub-requires are isolated also
 * 
 * @param { string } file - file to require in an isolated context
 * @param { string } preScript - JavaScript to run before requiring file 
 */
const isolatedRequire = (file, preScript='') => {
  const filename = require.resolve(file);
  const dirname = path.dirname(filename);
  const SandboxModule = Module
  const sandbox = {}
  const dependencies = new Set();

  SandboxModule.prototype._compile = function (content, filename) {
    const self = this;
    sandbox.module = self;
    sandbox.exports = self.exports

    const require = path => {
      if (!path || typeof path !== 'string') {
        throw new Error('require path must be a string')
      }
      path = require.resolve(path);
      // if is a dependency of the main file store it
      if (filename === file) {
        dependencies.add(path)
      }
      return SandboxModule._load(path, self)
    };

    require.main = sandbox.main
    require.cache = SandboxModule._cache
    require.extensions = SandboxModule._extensions

    require.resolve = function(request) {
      return SandboxModule._resolveFilename(request, self);
    }

    const closure = vm.runInContext(SandboxModule.wrap(content), sandbox, { filename })
    closure(self.exports, require, self, filename, path.dirname(filename))
  }

  SandboxModule._cache = {}
  SandboxModule.prototype._compile.bind(SandboxModule)

  const extensions = {
    // load js
    ['.js'](mod, filename) {
      var content = require('fs').readFileSync(filename, 'utf8');
      mod._compile(content, filename);
    },
    // load json
    ['.json'](mod, filename) {
      const content = require('fs').readFileSync(filename, 'utf8')
      mod.exports = JSON.parse(content)
    },
    // load native module
    ['.node'](mod, filename) {
      mod.exports = require(filename)
    },
  }

  SandboxModule._extensions = extensions

  sandbox.exports = {};
  sandbox.Buffer = Buffer;
  sandbox.global = sandbox;
  sandbox.console = console;
  sandbox.__dirname = dirname;
  sandbox.__filename = filename;
  sandbox.setTimeout = setTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setImmediate = setImmediate;
  sandbox.clearInterval = clearInterval;
  sandbox.getRunner = global.getRunner;
  sandbox.module = new SandboxModule(filename, this);
  sandbox.main = sandbox.module;
  // TODO: might be better to proxy calls to process
  sandbox.process = Object.assign({}, process, {
    exit: () => {
      throw new Error('unexpected-exit')
    },
    chdir: () => {
      throw new Error('unexpected-chdir')
    },
    on: () => {
      // maybe allow, maybe not
    },
  })

  sandbox.require = path => {
    if (!path || typeof path !== 'string') {
      throw new Error('require path must be a string')
    }
    path = sandbox.require.resolve(path);
    return SandboxModule._load(path)
  };

  sandbox.require.main = sandbox.module
  sandbox.require.resolve = require.resolve
  sandbox.require.cache = SandboxModule._cache
  sandbox.require.extensions = SandboxModule._extensions

  vm.createContext(sandbox)
  
  vm.runInContext(`
    ${preScript}
    require('${filename}');
    
  `, sandbox, { filename })

  return { dependencies: Array.from(dependencies) }
}

module.exports = isolatedRequire
