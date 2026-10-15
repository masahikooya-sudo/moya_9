// Apps Script の純粋ロジック（src/*.js）を 1 つのグローバルスコープに読み込むテスト用ローダー
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PURE_FILES = ['Parser.js', 'Slots.js', 'Templates.js'];

function loadGas() {
  const context = vm.createContext({ console });
  for (const f of PURE_FILES) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  return context;
}

module.exports = { loadGas };
