#!/usr/bin/env node
// WristKey e2e — 构建产物与签名一致性检查（band-app .rpk + android-app APK）。
//
// 用法（在仓库根目录或 e2e/ 下执行均可）：
//   node e2e/check-build.mjs                    # 只做静态检查（产物存在 / 包名 / 签名一致性）
//   node e2e/check-build.mjs --with-tests       # 额外跑 band-app npm test、android gradle testDebugUnitTest
//   node e2e/check-build.mjs --build            # 额外跑 band-app npm run release、android gradlew assembleRelease
//   node e2e/check-build.mjs --build --with-tests
//
// 产物检查项：
//   1. band-app/dist/*.rpk 存在，manifest.package=dev.wristkey.app、name=腕证、deviceTypeList 含 watch；
//   2. android-app APK 存在，package=dev.wristkey.app、应用名 腕证；
//   3. APK 签名证书 SHA-256 == signing/rpk-sign/certificate.pem；
//   4. .rpk 字节流内嵌同一证书 DER（aiot-toolkit 签名块）；
//   5. 三类指纹一致（APK / PEM / RPK 内嵌）。
// 结果写入 reports/e2e-build-result.json，退出码：0 = 无 FAIL（SKIP 可接受），1 = 有 FAIL。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

import { base32Encode } from './lib/encoding.mjs';

const E2E_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(E2E_ROOT, '..');
const REPORTS = join(WORKSPACE, 'reports');
const TARGET_PACKAGE = 'dev.wristkey.app';
const TARGET_APP_NAME = '腕证';
// 版本：band .rpk 1.0.4（UI v3：无顶栏/3 码每页/首字母筛选）/ APK 1.2（Bitwarden 导入）
const EXPECTED_BAND_VERSION = '1.0.4';
const EXPECTED_BAND_VERSION_CODE = 5;
const EXPECTED_APK_VERSION = '1.2';
const EXPECTED_APK_VERSION_CODE = 3;

const argv = process.argv.slice(2);
const flags = {
  build: argv.includes('--build'),
  withTests: argv.includes('--with-tests')
};

const checks = [];

function record(name, status, detail, command) {
  checks.push({ name, status, detail: detail || '', command: command || '' });
  const line = '  [' + status + '] ' + name + (detail ? ' — ' + detail : '');
  process.stdout.write(line + '\n');
}

function pass(name, detail, command) {
  record(name, 'PASS', detail, command);
}

function fail(name, detail, command) {
  record(name, 'FAIL', detail, command);
}

function skip(name, detail, command) {
  record(name, 'SKIP', detail, command);
}

// JDK 探测（gradle / apksigner / keytool 都需要 java；无 JDK 时相关检查 SKIP）
let cachedJdkHome;
function javaHome() {
  if (cachedJdkHome === undefined) {
    cachedJdkHome = findJdkHome();
  }
  return cachedJdkHome;
}

function run(command, args, options) {
  const opts = options || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const jdk = javaHome();
  if (jdk) {
    env.JAVA_HOME = jdk;
    env.PATH = join(jdk, 'bin') + ':' + (process.env.PATH || '');
  }
  const result = spawnSync(command, args, {
    cwd: opts.cwd || WORKSPACE,
    encoding: opts.binary ? null : 'utf8',
    timeout: opts.timeout || 600000,
    env
  });
  return {
    status: result.status,
    ok: result.status === 0,
    stdout: opts.binary ? result.stdout : result.stdout || '',
    stderr: opts.binary ? result.stderr || '' : result.stderr || '',
    error: result.error ? String(result.error.message) : null
  };
}

function countBandTests(text) {
  const match = String(text || '').match(/# tests (\d+)/);
  return match ? Number(match[1]) : null;
}

function countAndroidTests(androidRoot) {
  const dir = join(androidRoot, 'app', 'build', 'test-results', 'testDebugUnitTest');
  if (!existsSync(dir)) {
    return null;
  }
  let total = 0;
  let failures = 0;
  let files = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.xml')) {
      continue;
    }
    const xml = readFileSync(join(dir, name), 'utf8');
    const match = xml.match(/<testsuite\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/);
    if (match) {
      total += Number(match[1]);
      failures += Number(match[2]);
      files += 1;
    }
  }
  return files > 0 ? { total, failures, files } : null;
}

function globNewest(directory, suffix) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter(function (name) {
      return name.endsWith(suffix);
    })
    .map(function (name) {
      const path = join(directory, name);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort(function (left, right) {
      return right.mtime - left.mtime;
    })
    .map(function (item) {
      return item.path;
    });
}

function findLatestBuildTool(name) {
  const root = join(os.homedir(), 'Android', 'Sdk', 'build-tools');
  if (!existsSync(root)) {
    return null;
  }
  const versions = readdirSync(root).sort(function (left, right) {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
      const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  });
  for (let index = versions.length - 1; index >= 0; index--) {
    const path = join(root, versions[index], name);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

function findJdkHome() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'java'))) {
    return process.env.JAVA_HOME;
  }
  const root = join(os.homedir(), '.jdks');
  if (!existsSync(root)) {
    return null;
  }
  for (const name of readdirSync(root)) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'bin', 'java'))) {
      return candidate;
    }
  }
  return null;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function firstLine(text) {
  return String(text || '').split('\n').find(Boolean) || '';
}

function relativePath(path) {
  return relative(WORKSPACE, path);
}

// ------------------------------------------------------------ 1. band-app
function checkBandApp() {
  process.stdout.write('\n## band-app\n');
  const bandRoot = join(WORKSPACE, 'band-app');
  if (!existsSync(join(bandRoot, 'package.json'))) {
    skip('band-app 存在', 'band-app/package.json 尚未就绪');
    return { rpk: null };
  }
  pass('band-app 存在', relativePath(join(bandRoot, 'package.json')));

  const manifestPath = join(bandRoot, 'src', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.package === TARGET_PACKAGE) {
        pass('band-app manifest.package', TARGET_PACKAGE);
      } else {
        fail('band-app manifest.package', '期望 ' + TARGET_PACKAGE + '，实际 ' + String(manifest.package));
      }
      if (manifest.name === TARGET_APP_NAME) {
        pass('band-app manifest.name', TARGET_APP_NAME);
      } else {
        fail('band-app manifest.name', '期望 ' + TARGET_APP_NAME + '，实际 ' + String(manifest.name));
      }
      const devices = Array.isArray(manifest.deviceTypeList) ? manifest.deviceTypeList : [];
      if (devices.indexOf('watch') >= 0) {
        pass('band-app deviceTypeList 含 watch');
      } else {
        fail('band-app deviceTypeList', JSON.stringify(devices));
      }
      const featureNames = (manifest.features || []).map(function (item) { return item && item.name; });
      for (const required of ['system.router', 'system.storage', 'system.interconnect']) {
        if (featureNames.indexOf(required) >= 0) {
          pass('band-app feature ' + required);
        } else {
          fail('band-app feature ' + required, 'features=' + JSON.stringify(featureNames));
        }
      }
      const designWidth = manifest.config && manifest.config.designWidth;
      if (designWidth === 'device-width') {
        pass('band-app config.designWidth', 'device-width');
      } else {
        fail('band-app config.designWidth', '期望 device-width，实际 ' + String(designWidth));
      }
    } catch (error) {
      fail('band-app src/manifest.json 可解析', String(error.message));
    }
  } else {
    skip('band-app src/manifest.json', '尚未生成（band-dev 构建中）');
  }

  if (flags.withTests) {
    if (existsSync(join(bandRoot, 'package.json'))) {
      const result = run('npm', ['test', '--silent'], { cwd: bandRoot, timeout: 300000 });
      const summary = firstLine(result.stdout.trim().split('\n').slice(-8).join('\n')) || String(result.status);
      const testCount = countBandTests(result.stdout);
      if (result.ok) {
        pass('band-app npm test', '退出码 0' + (testCount ? '，' + testCount + ' 个用例通过' : ''), 'npm test');
      } else {
        fail('band-app npm test', '退出码 ' + result.status + ': ' + (firstLine(result.stderr) || summary), 'cd band-app && npm test');
      }
    }
  }

  if (flags.build) {
    if (!existsSync(manifestPath)) {
      skip('band-app npm run release', 'src/manifest.json 缺失，跳过构建');
    } else {
      const result = run('npm', ['run', 'release'], { cwd: bandRoot, timeout: 600000 });
      if (result.ok) {
        pass('band-app npm run release', '退出码 0', 'cd band-app && npm run release');
      } else {
        fail(
          'band-app npm run release',
          '退出码 ' + result.status + ': ' + (firstLine(result.stderr) || firstLine(result.stdout)),
          'cd band-app && npm run release'
        );
      }
    }
  }

  const allRpks = globNewest(join(bandRoot, 'dist'), '.rpk');
  const releaseRpks = allRpks.filter(function (path) {
    return /\.release\./.test(path);
  });
  // 终验以 release rpk 为准；没有 release 时才回退到最新的任意 rpk
  const rpks = releaseRpks.length > 0 ? releaseRpks : allRpks;
  if (rpks.length === 0) {
    skip('band-app dist/*.rpk', '未找到 .rpk（构建后重跑）');
    return { rpk: null };
  }
  const rpk = rpks[0];
  pass('band-app dist/*.rpk 存在', relativePath(rpk) + ' (' + statSync(rpk).size + 'B)');

  const unzip = run('unzip', ['-p', rpk, 'manifest.json']);
  if (!unzip.ok) {
    fail('rpk manifest.json 可读取', 'unzip 失败: ' + firstLine(unzip.stderr));
    return { rpk };
  }
  let rpkManifest = null;
  try {
    rpkManifest = JSON.parse(unzip.stdout);
  } catch (error) {
    fail('rpk manifest.json 可解析', String(error.message));
    return { rpk };
  }
  if (rpkManifest.package === TARGET_PACKAGE) {
    pass('rpk manifest.package', TARGET_PACKAGE);
  } else {
    fail('rpk manifest.package', '期望 ' + TARGET_PACKAGE + '，实际 ' + String(rpkManifest.package) + '（可能是参考实现遗留产物，需重新构建）');
  }
  if (rpkManifest.name === TARGET_APP_NAME) {
    pass('rpk manifest.name', TARGET_APP_NAME);
  } else {
    fail('rpk manifest.name', '期望 ' + TARGET_APP_NAME + '，实际 ' + String(rpkManifest.name));
  }
  if (rpkManifest.versionName === EXPECTED_BAND_VERSION) {
    pass('rpk versionName', EXPECTED_BAND_VERSION);
  } else {
    fail('rpk versionName', '期望 ' + EXPECTED_BAND_VERSION + '（UI v3 版），实际 ' + String(rpkManifest.versionName));
  }
  if (rpkManifest.versionCode === EXPECTED_BAND_VERSION_CODE) {
    pass('rpk versionCode', String(EXPECTED_BAND_VERSION_CODE));
  } else {
    fail('rpk versionCode', '期望 ' + EXPECTED_BAND_VERSION_CODE + '，实际 ' + String(rpkManifest.versionCode));
  }
  return { rpk, rpkManifest };
}

// ------------------------------------------- 1b. band UI v3 静态检查
function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function checkBandUiV3() {
  process.stdout.write('\n## band UI v3\n');
  const bandRoot = join(WORKSPACE, 'band-app');
  const srcRoot = join(bandRoot, 'src');
  const indexUx = readIfExists(join(srcRoot, 'pages', 'index', 'index.ux'));
  const pickerUx = readIfExists(join(srcRoot, 'pages', 'picker', 'picker.ux'));
  const settingsJs = readIfExists(join(srcRoot, 'common', 'scripts', 'settings.js'));
  const manifestPath = join(srcRoot, 'manifest.json');

  // 1) index.ux 无顶栏：不应出现 header/top-bar/status 行等标记
  if (!indexUx) {
    fail('UI v3 index.ux 存在', '缺少 src/pages/index/index.ux');
  } else {
    pass('UI v3 index.ux 存在', 'src/pages/index/index.ux');
    const topBarMarkers = ['class="header"', "class='header'", 'class="top-bar"', "class='top-bar'", 'class="topbar"', 'class="status"', "class='status'", 'class="status-bar"', 'status-bar', 'app-title'];
    const foundMarkers = topBarMarkers.filter(function (marker) { return indexUx.indexOf(marker) >= 0; });
    if (foundMarkers.length === 0) {
      pass('UI v3 无顶栏（index.ux 无 header/status 行）', '未发现顶栏标记');
    } else {
      fail('UI v3 无顶栏（index.ux 无 header/status 行）', '发现顶栏标记: ' + foundMarkers.join(', '));
    }
    if (indexUx.indexOf('class="rail"') >= 0 && /letter-button|openPicker/.test(indexUx)) {
      pass('UI v3 右侧 rail（A-Z 按钮）', 'index.ux 含 rail + letter-button/openPicker');
    } else {
      fail('UI v3 右侧 rail（A-Z 按钮）', 'index.ux 缺少 rail/letter-button/openPicker');
    }
    if (/pages\/picker/.test(indexUx)) {
      pass('UI v3 index 打开 picker 路由', 'index.ux 引用 pages/picker');
    } else {
      fail('UI v3 index 打开 picker 路由', 'index.ux 未引用 pages/picker');
    }
  }

  // 2) 每页 3 个：ACCOUNTS_PER_PAGE = 3 且 index 使用分页
  if (!settingsJs) {
    fail('UI v3 ACCOUNTS_PER_PAGE 常量', '缺少 src/common/scripts/settings.js');
  } else {
    const match = settingsJs.match(/export\s+const\s+ACCOUNTS_PER_PAGE\s*=\s*(\d+)/);
    if (match && Number(match[1]) === 3) {
      pass('UI v3 ACCOUNTS_PER_PAGE = 3');
    } else {
      fail('UI v3 ACCOUNTS_PER_PAGE = 3', '实际 ' + (match ? match[1] : '未找到常量'));
    }
    if (/export\s+function\s+filterAccountsByLetter|filterAccountsByLetter\s*=/.test(settingsJs) &&
        /export\s+function\s+normalizeLetterFilter|normalizeLetterFilter\s*=/.test(settingsJs)) {
      pass('UI v3 字母筛选函数（filterAccountsByLetter/normalizeLetterFilter）');
    } else {
      fail('UI v3 字母筛选函数', 'settings.js 缺少 filterAccountsByLetter/normalizeLetterFilter');
    }
    if (settingsJs.indexOf('wristkey_letter_filter') >= 0) {
      pass('UI v3 筛选持久化 key（wristkey_letter_filter）');
    } else {
      fail('UI v3 筛选持久化 key', 'settings.js 缺少 wristkey_letter_filter');
    }
    if (/export\s+function\s+letterBucket|letterBucket\s*=/.test(settingsJs) &&
        /export\s+function\s+buildLetterCounts|buildLetterCounts\s*=/.test(settingsJs)) {
      pass('UI v3 字母桶/计数函数（letterBucket/buildLetterCounts）');
    } else {
      fail('UI v3 字母桶/计数函数', 'settings.js 缺少 letterBucket/buildLetterCounts');
    }
  }
  if (indexUx) {
    if (indexUx.indexOf('ACCOUNTS_PER_PAGE') >= 0 && /paginate\(/.test(indexUx)) {
      pass('UI v3 index 使用 ACCOUNTS_PER_PAGE 分页', 'paginate(currentAccounts, page, ACCOUNTS_PER_PAGE)');
    } else {
      fail('UI v3 index 使用 ACCOUNTS_PER_PAGE 分页', 'index.ux 未使用 ACCOUNTS_PER_PAGE/paginate');
    }
  }

  // 3) picker 页与 manifest 路由注册
  if (pickerUx) {
    pass('UI v3 picker 页存在', 'src/pages/picker/picker.ux');
    if (pickerUx.indexOf('首字母筛选') >= 0) {
      pass('UI v3 picker 标题', '含“首字母筛选”');
    } else {
      fail('UI v3 picker 标题', 'picker.ux 缺少“首字母筛选”');
    }
    if (/LETTER_BUCKET_KEYS|LETTER_KEYS|"全部"|'全部'/.test(pickerUx) && pickerUx.indexOf('#') >= 0) {
      pass('UI v3 picker 字母桶/全部/# 渲染', 'picker.ux 含字母桶与全部/#');
    } else {
      fail('UI v3 picker 字母桶/全部/# 渲染', 'picker.ux 缺少字母桶或全部/#');
    }
  } else {
    fail('UI v3 picker 页存在', '缺少 src/pages/picker/picker.ux');
  }
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const pages = (manifest.router && manifest.router.pages) || {};
      if (pages['pages/picker']) {
        pass('UI v3 manifest 注册 pages/picker');
      } else {
        fail('UI v3 manifest 注册 pages/picker', 'router.pages 缺少 pages/picker');
      }
    } catch (error) {
      fail('UI v3 manifest 可解析', String(error.message));
    }
  }

  // 3b) menu 页移除分类入口（UI v3：分类不再影响主列表）
  const menuUx = readIfExists(join(srcRoot, 'pages', 'menu', 'menu.ux'));
  if (menuUx) {
    if (menuUx.indexOf('pages/category') < 0 && menuUx.indexOf('分类') < 0) {
      pass('UI v3 menu 无分类入口');
    } else {
      fail('UI v3 menu 无分类入口', 'menu.ux 仍引用分类/pages/category');
    }
  } else {
    fail('UI v3 menu 页存在', '缺少 src/pages/menu/menu.ux');
  }

  // 4) 字母桶/筛选/分页测试存在（node:test 用例）
  const testsDir = join(bandRoot, 'tests');
  if (!existsSync(testsDir)) {
    fail('UI v3 字母桶/筛选测试存在', '缺少 band-app/tests');
    return;
  }
  const testFiles = readdirSync(testsDir).filter(function (name) { return name.endsWith('.test.mjs'); });
  const candidates = testFiles.filter(function (name) {
    const source = readFileSync(join(testsDir, name), 'utf8');
    // 只认字母桶/筛选测试；category 的 filter 测试不算
    return /letter|bucket|picker/i.test(source);
  });
  if (candidates.length > 0) {
    pass('UI v3 字母桶/筛选测试存在', candidates.join(', '));
  } else {
    fail('UI v3 字母桶/筛选测试存在', 'tests/ 下没有覆盖 letter/filter/bucket 的测试文件');
  }
  const allTestSource = testFiles.map(function (name) { return readFileSync(join(testsDir, name), 'utf8'); }).join('\n');
  if (/ACCOUNTS_PER_PAGE|paginate/i.test(allTestSource)) {
    pass('UI v3 分页测试存在', 'tests/ 覆盖 ACCOUNTS_PER_PAGE/paginate');
  } else {
    fail('UI v3 分页测试存在', 'tests/ 未覆盖 ACCOUNTS_PER_PAGE/paginate');
  }
  if (/letterBucket/i.test(allTestSource) && /buildLetterCounts/i.test(allTestSource)) {
    pass('UI v3 字母桶计数测试存在', 'tests/ 覆盖 letterBucket/buildLetterCounts');
  } else {
    fail('UI v3 字母桶计数测试存在', 'tests/ 未覆盖 letterBucket/buildLetterCounts');
  }
}

// ---------------------------------------------------------- 2. android-app
function checkAndroidApp() {
  process.stdout.write('\n## android-app\n');
  const androidRoot = join(WORKSPACE, 'android-app');
  if (!existsSync(join(androidRoot, 'gradlew'))) {
    skip('android-app 存在', 'android-app/gradlew 尚未就绪');
    return { apk: null };
  }
  pass('android-app 存在', relativePath(join(androidRoot, 'gradlew')));

  const jdkHome = javaHome();
  if (jdkHome) {
    pass('JDK 可用', jdkHome);
  } else {
    skip('JDK 可用', '未找到 JAVA_HOME 或 ~/.jdks 下的 JDK（无法运行 gradle/apksigner 相关检查）');
  }

  if (flags.withTests || flags.build) {
    if (!jdkHome) {
      skip('android gradle 任务', '缺少 JDK');
    } else {
      const tasks = [];
      if (flags.withTests) {
        tasks.push('testDebugUnitTest');
      }
      if (flags.build) {
        tasks.push('assembleRelease');
      }
      const result = run('./gradlew', tasks.concat(['--console=plain', '--no-daemon']), {
        cwd: androidRoot,
        timeout: 900000,
        env: { JAVA_HOME: jdkHome, PATH: join(jdkHome, 'bin') + ':' + process.env.PATH }
      });
      const command = 'cd android-app && JAVA_HOME=' + jdkHome + ' ./gradlew ' + tasks.join(' ');
      const androidTests = flags.withTests ? countAndroidTests(androidRoot) : null;
      if (result.ok) {
        pass(
          'android gradle ' + tasks.join(' '),
          '退出码 0' +
            (androidTests ? '，' + androidTests.total + ' 个用例通过（' + androidTests.files + ' 个测试类）' : ''),
          command
        );
      } else {
        const tail = result.stdout.trim().split('\n').slice(-6).join(' | ');
        fail('android gradle ' + tasks.join(' '), '退出码 ' + result.status + ': ' + tail, command);
      }
    }
  }

  const apkCandidates = [
    join(androidRoot, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(androidRoot, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  ].filter(function (path) {
    return existsSync(path);
  });
  if (apkCandidates.length === 0) {
    skip('android APK 产物', '未找到 app/build/outputs/apk/**/*.apk（构建后重跑）');
    return { apk: null };
  }
  const apk = apkCandidates[0];
  pass('android APK 存在', relativePath(apk) + ' (' + statSync(apk).size + 'B)');

  const aapt2 = findLatestBuildTool('aapt2');
  const apksigner = findLatestBuildTool('apksigner');
  if (aapt2) {
    const badging = run(aapt2, ['dump', 'badging', apk]);
    if (badging.ok) {
      const packageMatch = badging.stdout.match(/package: name='([^']+)'/);
      const labelMatch = badging.stdout.match(/application-label:'([^']*)'/);
      const packageName = packageMatch ? packageMatch[1] : null;
      const label = labelMatch ? labelMatch[1] : null;
      const versionMatch = badging.stdout.match(/versionName='([^']+)'/);
      const versionCodeMatch = badging.stdout.match(/versionCode='([^']+)'/);
      const versionName = versionMatch ? versionMatch[1] : null;
      const versionCode = versionCodeMatch ? Number(versionCodeMatch[1]) : null;
      if (packageName === TARGET_PACKAGE) {
        pass('APK package', TARGET_PACKAGE);
      } else {
        fail('APK package', '期望 ' + TARGET_PACKAGE + '，实际 ' + String(packageName));
      }
      if (label === TARGET_APP_NAME) {
        pass('APK 应用名', TARGET_APP_NAME);
      } else {
        fail('APK 应用名', '期望 ' + TARGET_APP_NAME + '，实际 ' + String(label));
      }
      if (versionName === EXPECTED_APK_VERSION) {
        pass('APK versionName', EXPECTED_APK_VERSION);
      } else {
        fail('APK versionName', '期望 ' + EXPECTED_APK_VERSION + '（Bitwarden 导入版），实际 ' + String(versionName));
      }
      if (versionCode === EXPECTED_APK_VERSION_CODE) {
        pass('APK versionCode', String(EXPECTED_APK_VERSION_CODE));
      } else {
        fail('APK versionCode', '期望 ' + EXPECTED_APK_VERSION_CODE + '，实际 ' + String(versionCode));
      }
    } else {
      fail('aapt2 dump badging', firstLine(badging.stderr) || String(badging.status), aapt2 + ' dump badging ' + apk);
    }
  } else {
    skip('aapt2 可用', '未在 ~/Android/Sdk/build-tools 找到 aapt2');
  }
  return { apk, apksigner };
}

// ------------------------------------------------- 3. 签名与包名一致性
function checkSigning(band, android) {
  process.stdout.write('\n## 签名与包名一致性\n');
  const certPem = join(WORKSPACE, 'signing', 'rpk-sign', 'certificate.pem');
  if (!existsSync(certPem)) {
    skip('signing/rpk-sign/certificate.pem', '缺失，跳过签名一致性检查');
    return;
  }
  const openssl = run('openssl', ['x509', '-in', certPem, '-noout', '-fingerprint', '-sha256']);
  const pemSha = openssl.ok
    ? openssl.stdout.replace(/.*=/, '').replace(/:/g, '').trim().toLowerCase()
    : null;
  if (pemSha) {
    pass('签名 PEM SHA-256', pemSha);
  } else {
    fail('签名 PEM SHA-256', firstLine(openssl.stderr));
  }

  // APK 证书指纹
  let apkSha = null;
  if (android.apk && android.apksigner) {
    const verify = run(android.apksigner, ['verify', '--print-certs', android.apk]);
    const match = verify.stdout.match(/SHA-256 digest: ([0-9a-f]+)/);
    apkSha = match ? match[1].toLowerCase() : null;
    if (apkSha) {
      pass('APK 证书 SHA-256', apkSha);
      if (pemSha) {
        if (apkSha === pemSha) {
          pass('APK 证书 == 签名 PEM', '三方一致');
        } else {
          fail('APK 证书 == 签名 PEM', 'APK=' + apkSha + ' PEM=' + pemSha);
        }
      }
    } else {
      fail('APK 证书 SHA-256', 'apksigner 输出无法解析: ' + firstLine(verify.stderr || verify.stdout));
    }
  } else {
    skip('APK 证书', '缺少 APK 或 apksigner');
  }

  // RPK 内嵌证书 DER
  if (band.rpk && existsSync(certPem)) {
    try {
      const derResult = run('openssl', ['x509', '-in', certPem, '-outform', 'DER'], { binary: true });
      const rpkBuffer = readFileSync(band.rpk);
      if (derResult.ok && Buffer.isBuffer(derResult.stdout) && derResult.stdout.length > 0) {
        const der = derResult.stdout;
        const offset = rpkBuffer.indexOf(der);
        if (offset >= 0) {
          pass('RPK 内嵌证书 DER', '命中 offset ' + offset);
        } else {
          fail('RPK 内嵌证书 DER', '未在 ' + relativePath(band.rpk) + ' 中找到签名证书');
        }
      } else {
        skip('RPK 内嵌证书 DER', 'openssl 输出 DER 失败');
      }
    } catch (error) {
      fail('RPK 内嵌证书 DER', String(error.message));
    }
  } else {
    skip('RPK 内嵌证书 DER', '缺少 RPK');
  }

  // 调用团队统一脚本做最终判定（若存在）
  const script = join(WORKSPACE, 'scripts', 'check-signing.sh');
  if (existsSync(script) && android.apk && band.rpk) {
    const result = run('bash', [script, android.apk, band.rpk], { timeout: 180000 });
    const command = 'bash scripts/check-signing.sh ' + relativePath(android.apk) + ' ' + relativePath(band.rpk);
    if (result.ok) {
      pass('scripts/check-signing.sh', firstLine(result.stdout.trim().split('\n').slice(-1).join('\n')), command);
    } else {
      fail('scripts/check-signing.sh', firstLine(result.stderr) || firstLine(result.stdout), command);
    }
  } else {
    skip('scripts/check-signing.sh', '缺少 APK/RPK 或脚本本身');
  }

  // 包名一致性
  if (android.apk && band.rpkManifest) {
    const aapt2 = findLatestBuildTool('aapt2');
    if (aapt2) {
      const badging = run(aapt2, ['dump', 'badging', android.apk]);
      const match = badging.ok ? badging.stdout.match(/package: name='([^']+)'/) : null;
      const apkPackage = match ? match[1] : null;
      if (apkPackage && apkPackage === band.rpkManifest.package) {
        pass('APK 与 RPK 包名一致', apkPackage);
      } else if (apkPackage) {
        fail('APK 与 RPK 包名一致', 'APK=' + apkPackage + ' RPK=' + String(band.rpkManifest.package));
      }
    }
  }
}

// ------------------------------------------------------------ 主流程
async function main() {
  process.stdout.write(
    'WristKey e2e build check: node ' + process.version + ' / ' + process.platform +
      (flags.build ? ' / --build' : '') + (flags.withTests ? ' / --with-tests' : '') + '\n'
  );
  const band = checkBandApp();
  checkBandUiV3();
  const android = checkAndroidApp();
  checkSigning(band, android);

  const passed = checks.filter(function (item) { return item.status === 'PASS'; }).length;
  const failed = checks.filter(function (item) { return item.status === 'FAIL'; }).length;
  const skipped = checks.filter(function (item) { return item.status === 'SKIP'; }).length;

  mkdirSync(REPORTS, { recursive: true });
  const resultFile = join(REPORTS, 'e2e-build-result.json');
  writeFileSync(
    resultFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform + ' ' + process.arch,
        flags,
        artifacts: {
          rpk: band.rpk ? relativePath(band.rpk) : null,
          apk: android.apk ? relativePath(android.apk) : null
        },
        summary: { passed, failed, skipped, total: checks.length },
        checks
      },
      null,
      2
    ) + '\n'
  );

  process.stdout.write('\n==========================================\n');
  process.stdout.write('构建检查: ' + passed + ' PASS / ' + failed + ' FAIL / ' + skipped + ' SKIP\n');
  process.stdout.write('结果: ' + relativePath(resultFile) + '\n');
  process.stdout.write('==========================================\n');
  if (failed > 0) {
    process.stdout.write('失败项：\n');
    for (const item of checks) {
      if (item.status === 'FAIL') {
        process.stdout.write('  - ' + item.name + ': ' + item.detail + '\n');
      }
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(function (error) {
  console.error('check-build 运行失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
