'use strict';
/* eslint-disable import/no-unassigned-import */
require('./ensure-forked');
require('./load-chalk');
require('./consume-argv');
require('./fake-tty');

const SingleProcessTestPool = require('../testpool/single-process-test-pool');
const options = require('./options').get();

const testPool = new SingleProcessTestPool(options.files, options);

testPool.run();
