'use strict';
const {test} = require('tap');
const {execCli} = require('../helper/cli');

test('enabling long stack traces will provide detailed debug information', t => {
	execCli('long-stack-trace', (err, stdout, stderr) => {
		t.ok(err);
		t.match(stderr, /From previous event/);
		t.end();
	});
});

test('`AssertionError` should capture infinity stack trace', t => {
	execCli('infinity-stack-trace.js', (err, stdout) => {
		t.ok(err);
		/*
			TODO: remove comment before finished

			This should be beautified by serializeError which shortens
			the path shown depending on `process.cwd()` so the test
			should use .*? instead of .+? since it might be executed
			from the same directory so there wouldn't be a plus 1 char
			which .+? requires to match
		*/
		t.match(stdout, /c \(.*?infinity-stack-trace\.js:7:18\)/);
		t.match(stdout, /b \(.*?infinity-stack-trace\.js:8:18\)/);
		t.match(stdout, /a \(.*?infinity-stack-trace\.js:10:2\)/);
		t.end();
	});
});
