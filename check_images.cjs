const db = require('better-sqlite3')('data/app.db');
const rows = db.prepare('SELECT id, substr(data, 1, 50) as prefix FROM images WHERE data NOT LIKE \'data:%\' LIMIT 10').all();
console.log("Images without prefix:", rows);
