let DatabaseImpl = null;

try {
    const BetterSqlite = require("better-sqlite3");
    // Test if bindings exist
    new BetterSqlite(":memory:").close();
    DatabaseImpl = BetterSqlite;
} catch (e) {
    const { DatabaseSync } = require("node:sqlite");

    function wrapDb(db) {
        let isOpen = true;
        Object.defineProperty(db, "open", {
            get() { return isOpen; }
        });

        const origClose = db.close.bind(db);
        db.close = () => {
            isOpen = false;
            return origClose();
        };

        if (!db.pragma) {
            db.pragma = (str) => {
                try {
                    return db.prepare("PRAGMA " + str).all();
                } catch (err) {
                    try {
                        db.exec("PRAGMA " + str);
                    } catch (e2) {}
                    return [];
                }
            };
        }

        if (!db.transaction) {
            db.transaction = (fn) => {
                return (...args) => {
                    db.exec("BEGIN");
                    try {
                        const res = fn(...args);
                        db.exec("COMMIT");
                        return res;
                    } catch (err) {
                        db.exec("ROLLBACK");
                        throw err;
                    }
                };
            };
        }

        const origPrepare = db.prepare.bind(db);
        db.prepare = (sql) => {
            const stmt = origPrepare(sql);
            const origGet = stmt.get.bind(stmt);
            const origAll = stmt.all.bind(stmt);
            stmt.get = (...args) => {
                const row = origGet(...args);
                return row ? { ...row } : undefined;
            };
            stmt.all = (...args) => {
                const rows = origAll(...args);
                return rows ? rows.map(r => ({ ...r })) : [];
            };
            return stmt;
        };

        return db;
    }

    DatabaseImpl = function(filePath, options = {}) {
        const db = new DatabaseSync(filePath);
        return wrapDb(db);
    };
}

module.exports = DatabaseImpl;
