import test from '../..';

test('argv', t => {
	t.deepEqual(process.argv.filter(a => a === '--hello' || a === 'world'), ['--hello', 'world']);
});
