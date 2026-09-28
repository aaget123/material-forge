import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * "打开方式"的候选程序：直接问 Windows 的注册表，**不弹系统对话框**。
 *
 * 为什么不能只读一个键：Windows 记"打开方式"的地方有好几处，而且形态不同——
 *  1. 后缀的默认 ProgID（`HKCR\.png` = `pngfile`）→ `HKCR\<ProgID>\shell\open\command`
 *  2. `OpenWithProgids`：可能是经典 ProgID（`Doubao.Image`），也可能是 **UWP 的 AppX ProgID**
 *     —— 后者没有命令行，只有 `HKCR\<ProgID>\Application` 里的 `AppUserModelID`，
 *     必须用 `explorer.exe shell:AppsFolder\<AUMID>` 启动
 *  3. `OpenWithList`：只有 **exe 文件名**（"Doubao.exe"），路径要另外找
 *
 * 所以这里的取舍是：**只给能真正启动的候选**，定位不到的宁可不出现在列表里
 * （前端会提示"还有 N 个没定位到，可以用『选择程序…』"），避免列一堆点了没反应的东西。
 */

export interface OpenWithCandidate {
  id: string;
  label: string;
  /** 用来启动的 exe（UWP 是 explorer.exe） */
  exe: string;
  /** 参数模板（%1 会被替换成文件路径） */
  args: string[];
  isDefault: boolean;
}

export interface OpenWithList {
  ext: string;
  items: OpenWithCandidate[];
  /** 注册表里提到、但定位不到可执行文件的候选数 */
  unresolved: number;
}

interface RegValue { name: string; data: string }

/**
 * reg.exe 按**系统 ANSI/OEM 代码页**输出（简体中文是 GBK），直接当 UTF-8 解码会得到乱码
 * （实测：`豆包图片查看器` 变成 `����ͼƬ鿴��`）。Node 自带 full ICU，可以直接用 gbk 解码。
 */
const gbkDecoder = ((): TextDecoder | null => {
  try {
    return new TextDecoder('gbk');
  } catch {
    return null;
  }
})();

function decodeReg(buffer: Buffer): string {
  if (gbkDecoder) {
    try {
      return gbkDecoder.decode(buffer);
    } catch {
      /* 落到 UTF-8 */
    }
  }
  return buffer.toString('utf8');
}

async function regQuery(key: string): Promise<RegValue[]> {
  try {
    const { stdout } = await run('reg.exe', ['query', key], {
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer',
    });
    const text = decodeReg(stdout as unknown as Buffer);
    const values: RegValue[] = [];
    for (const raw of text.split(/\r?\n/)) {
      // 只去左边的缩进：`OpenWithProgids` 里的值数据是空的（REG_NONE），
      // 如果把右边也 trim 掉，"类型"和值之间那两格分隔就没了，整行会匹配不上（踩过）
      const line = raw.replace(/^[ \t]+/, '');
      if (!line || line.startsWith('HKEY')) continue;
      const match = /^(.*?)[ \t]{2,}(REG_[A-Z_]+)(?:[ \t]{2,}(.*))?$/.exec(line);
      if (!match) continue;
      values.push({ name: match[1] === '(Default)' ? '' : match[1], data: (match[3] ?? '').trim() });
    }
    return values;
  } catch {
    return [];
  }
}

async function regDefault(key: string): Promise<string | null> {
  const found = (await regQuery(key)).find((value) => value.name === '');
  return found && found.data.trim() ? found.data.trim() : null;
}

/** 展开 %SystemRoot% 这类环境变量 */
function expand(value: string): string {
  return value.replace(/%([^%]+)%/g, (_all, name: string) => process.env[name] ?? `%${name}%`);
}

/** 把 `"C:\...\app.exe" "%1"` 拆成 exe + 其余参数 */
function splitCommand(command: string): { exe: string; args: string[] } | null {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of command.trim()) {
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ' ' && !quoted) { if (current) { parts.push(current); current = ''; } continue; }
    current += char;
  }
  if (current) parts.push(current);
  const [exe, ...args] = parts;
  return exe ? { exe: expand(exe), args } : null;
}

/** 常见安装位置里找 exe（只扫两层，够覆盖绝大多数量应用） */
function findInCommonRoots(name: string): string | null {
  const roots = [
    expand('%LOCALAPPDATA%\\Programs'),
    expand('%PROGRAMFILES%'),
    expand('%PROGRAMFILES(X86)%'),
    expand('%APPDATA%'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, name);
    if (existsSync(direct)) return direct;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const guess = join(root, entry.name, name);
        if (existsSync(guess)) return guess;
      }
    } catch {
      /* 权限问题：跳过这个根 */
    }
  }
  return null;
}

/** exe 名字 → 完整路径（App Paths → Applications 命令行 → 常见安装位置） */
async function resolveExePath(name: string): Promise<{ exe: string; args: string[] } | null> {
  if (name.includes('\\')) return existsSync(name) ? { exe: name, args: [] } : null;
  for (const root of ['HKLM', 'HKCU']) {
    const value = await regDefault(`${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`);
    if (value) {
      const cleaned = expand(value.replace(/^"|"$/g, ''));
      if (existsSync(cleaned)) return { exe: cleaned, args: [] };
    }
  }
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\SOFTWARE\\Classes']) {
    const command = await regDefault(`${root}\\Applications\\${name}\\shell\\open\\command`);
    if (command) {
      const split = splitCommand(command);
      if (split && existsSync(split.exe)) return split;
    }
  }
  const found = findInCommonRoots(name);
  return found ? { exe: found, args: [] } : null;
}

/** 读一个键下面的**具名值**（注意：具名值不能像默认值那样用 `reg query 键 /ve` 读） */
async function regNamed(key: string, name: string): Promise<string | null> {
  const found = (await regQuery(key)).find((value) => value.name.toLowerCase() === name.toLowerCase());
  return found && found.data.trim() ? found.data.trim() : null;
}

/** 资源引用长得像 `@{包名?ms-resource://...}`：这种当标签太丑，剥成可读的短名 */
function cleanLabel(raw: string | null, aumid: string): string {
  const known: Array<[RegExp, string]> = [
    [/Microsoft\.Windows\.Photos/i, '照片'],
    [/Microsoft\.Windows\.MediaPlayer/i, '媒体播放器'],
    [/Microsoft\.WindowsNotepad/i, '记事本'],
    [/Microsoft\.Windows\.Paint/i, '画图'],
    [/Microsoft\.Windows\.Store/i, '应用商店'],
  ];
  for (const [pattern, label] of known) {
    if (pattern.test(aumid)) return label;
  }
  if (raw && !raw.startsWith('@{') && !raw.includes('ms-resource') && raw.length < 40) return raw;
  const pkg = aumid.split('!')[0] ?? aumid;
  const parts = pkg.split('_')[0]?.split('.') ?? [];
  return parts[parts.length - 1] || pkg;
}

/** ProgID → 候选（UWP 的 AppUserModelID 或经典命令行；都没有就返回 null） */
async function fromProgId(progId: string, isDefault: boolean): Promise<OpenWithCandidate | null> {
  const debug = process.env['PM_DEBUG_OPENWITH'] === '1';
  const friendly = await regDefault(`HKCR\\${progId}`);
  const appKey = `HKCR\\${progId}\\Application`;
  const aumid = await regNamed(appKey, 'AppUserModelId');
  if (debug) console.error(`[openwith] ${progId} friendly=${friendly} aumid=${aumid}`);
  if (aumid) {
    const appName = await regNamed(appKey, 'ApplicationName');
    return {
      id: `uwp:${aumid}`,
      label: cleanLabel(appName, aumid),
      exe: 'explorer.exe',
      args: [`shell:AppsFolder\\${aumid}`],
      isDefault,
    };
  }

  const command = await regDefault(`HKCR\\${progId}\\shell\\open\\command`);
  if (command) {
    const split = splitCommand(command);
    if (split) {
      if (existsSync(split.exe)) {
        return {
          id: `progid:${progId}`,
          label: friendly && friendly.length < 40 ? friendly : basename(split.exe),
          exe: split.exe,
          args: split.args,
          isDefault,
        };
      }
      const resolved = await resolveExePath(basename(split.exe));
      if (resolved) {
        return {
          id: `progid:${progId}`,
          label: friendly && friendly.length < 40 ? friendly : basename(resolved.exe),
          exe: resolved.exe,
          args: split.args,
          isDefault,
        };
      }
    }
  }

  // 有些"应用式"ProgID 没有命令行，只在 ApplicationIcon 里留着 exe 路径（形如 D:\...\App.exe,0）
  const icon = await regNamed(appKey, 'ApplicationIcon');
  if (icon && !icon.startsWith('@{')) {
    const exePath = icon.replace(/,\s*-?\d+$/, '');
    if (existsSync(exePath)) {
      const appName = await regNamed(appKey, 'ApplicationName');
      return {
        id: `icon:${exePath}`,
        label: cleanLabel(appName ?? friendly, progId),
        exe: exePath,
        args: [],
        isDefault,
      };
    }
  }
  return null;
}

export async function listOpenWith(ext: string): Promise<OpenWithList> {
  const cleanExt = ext.toLowerCase();
  if (!cleanExt.startsWith('.') || cleanExt.length < 2) return { ext: cleanExt, items: [], unresolved: 0 };

  const items = new Map<string, OpenWithCandidate>();
  let unresolved = 0;
  const add = (candidate: OpenWithCandidate | null): void => {
    if (!candidate) return;
    const key = candidate.id.toLowerCase();
    if (!items.has(key)) items.set(key, candidate);
  };

  const fileExts = `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${cleanExt}`;

  // 1) 系统默认
  const defaultProgId = await regDefault(`HKCR\\${cleanExt}`);
  if (defaultProgId) add(await fromProgId(defaultProgId, true));

  // 2) OpenWithProgids（经典 + UWP 都可能在这里）
  for (const root of [`HKCU\\${fileExts}\\OpenWithProgids`, `HKLM\\${fileExts}\\OpenWithProgids`, `HKCR\\${cleanExt}\\OpenWithProgids`]) {
    for (const entry of await regQuery(root)) {
      if (!entry.name) continue;
      const candidate = await fromProgId(entry.name, false);
      if (candidate) add(candidate);
      else unresolved++;
    }
  }

  // 3) OpenWithList：只有 exe 名，尽量定位；定位不到就计入 unresolved
  const list = await regQuery(`HKCU\\${fileExts}\\OpenWithList`);
  const mru = list.find((value) => value.name === 'MRUList')?.data ?? '';
  const ordered = [...list.filter((value) => value.name !== 'MRUList')].sort((a, b) => {
    const ai = mru.indexOf(a.name);
    const bi = mru.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const entry of ordered) {
    const name = entry.data.trim();
    if (!name) continue;
    const resolved = await resolveExePath(name);
    if (!resolved) { unresolved++; continue; }
    add({
      id: `exe:${resolved.exe}`,
      label: basename(resolved.exe),
      exe: resolved.exe,
      args: resolved.args.length > 0 ? resolved.args : [],
      isDefault: false,
    });
  }

  return { ext: cleanExt, items: [...items.values()], unresolved };
}

export function launchCandidate(candidate: OpenWithCandidate, filePath: string): void {
  const args = candidate.args.length > 0
    ? candidate.args.map((arg) => arg.replace(/%1|%L/gi, filePath))
    : [filePath];
  const child = spawn(candidate.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}
