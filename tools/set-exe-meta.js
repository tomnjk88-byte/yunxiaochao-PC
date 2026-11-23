/*
 * 给打包出来的 exe 补图标与版本信息。
 *
 * Linux 上 electron-packager 改 Windows 资源要靠 wine，没有 wine 就静默跳过，
 * 产物会顶着 Electron 的默认图标。这里用纯 JS 的 PE 编辑器补一遍。
 *
 * 用法：node tools/set-exe-meta.js "dist/YunX Guide PC-win32-x64/YunX Guide PC.exe"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('找不到 exe：' + target);
  process.exit(1);
}

const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
const exe = NtExecutable.from(fs.readFileSync(target), { ignoreCert: true });
const res = NtExecutableResource.from(exe);

const iconFile = Data.IconFile.from(fs.readFileSync(iconPath));
const groups = Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;

Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  groupId,
  lang,
  iconFile.icons.map((i) => i.data)
);

try {
  const versions = Resource.VersionInfo.fromEntries(res.entries);
  if (versions.length) {
    const vi = versions[0];
    const langs = vi.getAllLanguagesForStringValues();
    const useLang = langs.length ? langs[0] : { lang: 1033, codepage: 1200 };
    vi.setStringValues(useLang, {
      ProductName: 'YunX Guide PC',
      FileDescription: 'YunX Guide PC - 云小抄',
      CompanyName: 'yunx-guide',
      LegalCopyright: 'AGPL-3.0',
      OriginalFilename: 'YunX Guide PC.exe',
      InternalName: 'yunx-guide-pc',
    });
    vi.outputToResourceEntries(res.entries);
  }
} catch (e) {
  console.warn('版本信息写入跳过：' + e.message);
}

res.outputResource(exe);
fs.writeFileSync(target, Buffer.from(exe.generate()));
console.log('已写入图标与版本信息：' + target);
