const fs = require('fs');
const path = require('path');

module.exports = function loadCommands() {
  const dir = path.join(__dirname, 'commands');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => require(path.join(dir, f)))
    .filter(c => c.data && c.execute);
};
