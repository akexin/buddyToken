/* 看板的空数据占位（APK 内置）。
 *
 * 仓库是公开的，真实数据文件 token-usage-data.js 一直在 .gitignore 里、不入库，
 * 所以打包时这里是一份空数据。应用启动后会自动去连电脑上的 buddyToken 服务
 * 拉取真实数据，并把结果缓存到手机本地——之后即使断网也能看上一次同步的内容。
 *
 * 结构与 token-usage-report.js --emit-js 生成的完全一致，只是各表为空。
 */
window.__TOKEN_DATA__ = {
  "v": 1,
  "gen": 0,
  "meta": { "turns": 0, "reqs": 0, "from": 0, "to": 0, "sources": [], "light": false, "kept": 0, "merged": false },
  "t": {},
  "ti": {},
  "bill": [],
  "uids": [],
  "acct": [],
  "hist": {}
};
