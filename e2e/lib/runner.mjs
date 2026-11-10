// WristKey e2e — 极简测试运行器：分组、PASS/FAIL、汇总、退出码。

import process from 'node:process';

export function createRunner(title) {
  const results = [];
  let currentSection = '默认';

  function section(name) {
    currentSection = name;
    process.stdout.write('\n## ' + name + '\n');
  }

  function record(name, fn, passed, error, extra) {
    results.push({ section: currentSection, name, passed, error, extra });
    const status = passed ? 'PASS' : 'FAIL';
    const suffix = extra ? ' (' + extra + ')' : '';
    process.stdout.write('  [' + status + '] ' + name + suffix + '\n');
    if (!passed) {
      const message = error && error.stack ? error.stack : String(error);
      process.stdout.write(
        message
          .split('\n')
          .map(function (line) {
            return '         ' + line;
          })
          .join('\n') + '\n'
      );
    }
  }

  function test(name, fn) {
    try {
      const value = fn();
      record(name, fn, true, null, typeof value === 'string' ? value : '');
      return true;
    } catch (error) {
      record(name, fn, false, error, '');
      return false;
    }
  }

  async function testAsync(name, fn) {
    try {
      const value = await fn();
      record(name, fn, true, null, typeof value === 'string' ? value : '');
      return true;
    } catch (error) {
      record(name, fn, false, error, '');
      return false;
    }
  }

  function finish() {
    const passed = results.filter(function (item) {
      return item.passed;
    }).length;
    const failed = results.length - passed;
    const lines = [
      '',
      '==========================================',
      title + ': ' + passed + ' passed, ' + failed + ' failed, ' + results.length + ' total',
      '=========================================='
    ];
    if (failed > 0) {
      lines.push('失败用例：');
      for (const item of results) {
        if (!item.passed) {
          lines.push('  - [' + item.section + '] ' + item.name);
        }
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
    return { passed, failed, total: results.length };
  }

  return { section, test, testAsync, finish, results };
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || 'assertEqual failed') +
        '\n  actual:   ' +
        JSON.stringify(actual) +
        '\n  expected: ' +
        JSON.stringify(expected)
    );
  }
}

export function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      (message || 'assertDeepEqual failed') +
        '\n  actual:   ' +
        String(actualJson).slice(0, 1200) +
        '\n  expected: ' +
        String(expectedJson).slice(0, 1200)
    );
  }
}

export function assertThrows(fn, messagePart) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) {
    throw new Error('expected function to throw' + (messagePart ? ' (' + messagePart + ')' : ''));
  }
  if (messagePart && String(thrown.message).indexOf(messagePart) < 0) {
    throw new Error(
      'expected error containing ' + JSON.stringify(messagePart) + ', got ' + JSON.stringify(String(thrown.message))
    );
  }
  return thrown;
}
