#!/usr/bin/env node
/**
 * Test script for the enhanced replace_in_file tool.
 * Verifies:
 * 1. Successful replacements work as before
 * 2. Line labels (e.g., "42 | ") are stripped before matching
 * 3. Error messages include search preview, closest match, and guidance
 */

const fs = require('fs');
const path = require('path');

const { TOOLS } = require('./modules/micro-agents');
const replaceInFile = TOOLS.replace_in_file;

const TEST_DIR = path.join(__dirname, 'tmp_test_replace');
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

function setup() {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function writeFile(relativePath, content) {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.writeFileSync(fullPath, content, 'utf8');
}

function readFile(relativePath) {
  const fullPath = path.join(TEST_DIR, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

async function runTest(name, fn) {
  console.log(`\n🧪 ${name}`);
  try {
    await fn();
  } catch (err) {
    console.log(`  💥 Unexpected error: ${err.message}`);
    failed++;
  }
}

// ─── Test 1: Basic successful replacement ───
runTest('Test 1: Basic successful replacement', async () => {
  writeFile('test1.txt', 'Hello World\nThis is a test.\nGoodbye.');
  const diff = `------- SEARCH\nHello World\n=======\nHello Universe\n+++++++ REPLACE`;
  const result = await replaceInFile.execute({ path: 'test1.txt', diff }, TEST_DIR);
  assert(result.includes('modified successfully'), 'Returns success message');
  assert(result.includes('1 replacement'), 'Reports 1 replacement');
  const content = readFile('test1.txt');
  assert(content.includes('Hello Universe'), 'Content was replaced');
  assert(content.includes('This is a test.'), 'Rest of content preserved');
});

// ─── Test 2: Multi-line successful replacement ───
runTest('Test 2: Multi-line successful replacement', async () => {
  writeFile('test2.txt', 'Line 1\nLine 2\nLine 3\nLine 4');
  const diff = `------- SEARCH\nLine 2\nLine 3\n=======\nLine B\nLine C\n+++++++ REPLACE`;
  const result = await replaceInFile.execute({ path: 'test2.txt', diff }, TEST_DIR);
  assert(result.includes('1 replacement'), 'Reports 1 replacement');
  const content = readFile('test2.txt');
  assert(content === 'Line 1\nLine B\nLine C\nLine 4', 'Multi-line replacement correct');
});

// ─── Test 3: Line labels stripped from search string ───
runTest('Test 3: Line labels stripped from search string', async () => {
  writeFile('test3.txt', 'const foo = "bar";\nconst baz = "qux";\nconsole.log(foo);');
  const diff = `------- SEARCH\n1 | const foo = "bar";\n2 | const baz = "qux";\n=======\nconst foo = "updated";\nconst baz = "updated";\n+++++++ REPLACE`;
  const result = await replaceInFile.execute({ path: 'test3.txt', diff }, TEST_DIR);
  assert(result.includes('1 replacement'), 'Reports 1 replacement');
  const content = readFile('test3.txt');
  assert(content.includes('const foo = "updated";'), 'Content replaced despite line labels in search');
  assert(content.includes('console.log(foo);'), 'Rest of content preserved');
});

// ─── Test 4: Error message includes search preview ───
runTest('Test 4: Error message includes search preview', async () => {
  writeFile('test4.txt', 'actual line one\nactual line two\nactual line three');
  const diff = `------- SEARCH\nwrong line one\nwrong line two\nwrong line three\n=======\nreplacement\n+++++++ REPLACE`;
  try {
    await replaceInFile.execute({ path: 'test4.txt', diff }, TEST_DIR);
    assert(false, 'Should have thrown an error');
  } catch (err) {
    const msg = err.message;
    assert(msg.includes('SEARCH block 1 not found'), 'Error mentions SEARCH block not found');
    assert(msg.includes('Search text preview (first 3 lines)'), 'Error includes search preview header');
    assert(msg.includes('wrong line one'), 'Error shows first line of search text');
    assert(msg.includes('wrong line two'), 'Error shows second line of search text');
    assert(msg.includes('wrong line three'), 'Error shows third line of search text');
  }
});

// ─── Test 5: Error message includes closest match ───
runTest('Test 5: Error message includes closest match', async () => {
  writeFile('test5.txt', 'function hello() {\n  return "world";\n}\nconsole.log(hello());');
  const diff = `------- SEARCH\nfunction hello() {\n  return "universe";\n}\n=======\nfunction goodbye() {\n  return "world";\n}\n+++++++ REPLACE`;
  try {
    await replaceInFile.execute({ path: 'test5.txt', diff }, TEST_DIR);
    assert(false, 'Should have thrown an error');
  } catch (err) {
    const msg = err.message;
    assert(msg.includes('Closest match found at line'), 'Error includes closest match line number');
    assert(msg.includes('read_file'), 'Error guides user to use read_file');
  }
});

// ─── Test 6: Error message includes exact match guidance ───
runTest('Test 6: Error message includes exact match guidance', async () => {
  writeFile('test6.txt', 'const x = 42;\nconst y = 99;');
  const diff = `------- SEARCH\nconst x = 43;\n=======\nconst x = 100;\n+++++++ REPLACE`;
  try {
    await replaceInFile.execute({ path: 'test6.txt', diff }, TEST_DIR);
    assert(false, 'Should have thrown an error');
  } catch (err) {
    const msg = err.message;
    assert(msg.includes('EXACTLY, including whitespace and indentation'), 'Error mentions exact match requirement');
  }
});

// ─── Test 7: Multiple replacements in one diff ───
runTest('Test 7: Multiple replacements in one diff', async () => {
  writeFile('test7.txt', 'alpha\nbeta\ngamma\ndelta');
  const diff = `------- SEARCH\nalpha\n=======\nALPHA\n+++++++ REPLACE\n------- SEARCH\ngamma\n=======\nGAMMA\n+++++++ REPLACE`;
  const result = await replaceInFile.execute({ path: 'test7.txt', diff }, TEST_DIR);
  assert(result.includes('2 replacement'), 'Reports 2 replacements');
  const content = readFile('test7.txt');
  assert(content === 'ALPHA\nbeta\nGAMMA\ndelta', 'Both replacements applied correctly');
});

// ─── Test 8: No valid blocks error ───
runTest('Test 8: No valid blocks error', async () => {
  writeFile('test8.txt', 'some content');
  try {
    await replaceInFile.execute({ path: 'test8.txt', diff: 'no blocks here' }, TEST_DIR);
    assert(false, 'Should have thrown an error');
  } catch (err) {
    assert(err.message.includes('No valid SEARCH/REPLACE blocks'), 'Error for no valid blocks');
  }
});

// ─── Test 9: File not found error ───
runTest('Test 9: File not found error', async () => {
  try {
    await replaceInFile.execute({ path: 'nonexistent.txt', diff: '------- SEARCH\nfoo\n=======\nbar\n+++++++ REPLACE' }, TEST_DIR);
    assert(false, 'Should have thrown an error');
  } catch (err) {
    assert(err.message.includes('File not found'), 'Error for missing file');
  }
});

// ─── Test 10: stripLineLabels helper works correctly ───
runTest('Test 10: stripLineLabels helper', async () => {
  const stripLineLabels = (text) => text.replace(/^\d+\|\s*/gm, '');
  const input = '42 | const foo = "bar";\n99 | const baz = "qux";';
  const output = stripLineLabels(input);
  assert(output === 'const foo = "bar";\nconst baz = "qux";', 'Line labels stripped correctly');
  const noLabels = 'const foo = "bar";\nconst baz = "qux";';
  assert(stripLineLabels(noLabels) === noLabels, 'No-op when no line labels');
  const mixed = '1 | line one\nplain line\n3 | line three';
  const mixedOutput = stripLineLabels(mixed);
  assert(mixedOutput === 'line one\nplain line\nline three', 'Mixed content handled correctly');
});

// ─── Summary ───
console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

cleanup();
process.exit(failed > 0 ? 1 : 0);
