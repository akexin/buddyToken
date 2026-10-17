/**
 * 原子写文件：同目录临时文件 → fsync → rename 覆盖。
 *
 * 为什么需要：token-usage-data.js 是「整个看板的数据源」，同步进程写一半被杀
 * （或断电）会留下半截 JSON，看板下次打开直接白屏。rename 是原子操作，读方
 * 要么看到旧文件、要么看到完整的新文件，不会看到中间态。
 *
 * Windows 上 fs.renameSync 覆盖已存在文件走的是 MoveFileEx(REPLACE_EXISTING)，
 * 同样是原子的；但杀毒软件偶尔会短暂占用目标文件导致 EPERM，所以带几次重试。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function sleepMs(ms) {
  // 主线程同步等待：只在 rename 重试时用，正常路径一次就过
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} file     目标文件（绝对或相对路径均可）
 * @param {string|Buffer} content
 * @param {string} [encoding] 默认 utf8；传 Buffer 时忽略
 */
function writeFileAtomic(file, content, encoding) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');

  try {
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, content, encoding || 'utf8');
      // 先落盘再改名：否则断电后可能 rename 成功、内容却是空的
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 已经关了就忽略 */ }
      }
    }

    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 3) throw e;
        sleepMs(40);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能根本没建出来 */ }
    throw e;
  }
}

module.exports = { writeFileAtomic };
