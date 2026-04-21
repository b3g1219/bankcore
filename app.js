const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const path = require('path');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'banksecret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Database connection
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'banknew',
    connectionLimit: 10
});



// Database connection - UPDATE THESE VALUES!
const db = mysql.createPool({
    host: 'mysql-berihu.alwaysdata.net',  // ← Your host from Step 2
    user: 'berihu_admin',                  // ← Your user from Step 2
    password: 'Heno%1219',                   // ← Your password from Step 2
    database: 'berihu_banknew',               // ← Your database name
    connectionLimit: 10
});
console.log('✅ Database pool created');

// ============ ROUTES ============

// Homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Check session
app.get('/api/session', (req, res) => {
    if (req.session.userId) {
        res.json({
            loggedIn: true,
            username: req.session.username,
            role: req.session.role
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// ⭐ LOGIN
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.query('SELECT * FROM users WHERE username = ? AND password = ?',
        [username, password],
        (err, results) => {
            if (err) {
                return res.json({ success: false, message: 'Database error' });
            }

            if (results.length > 0) {
                const user = results[0];
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.role = user.role;
                req.session.fullName = user.full_name;

                req.session.save(err => {
                    if (err) {
                        return res.json({ success: false, message: 'Session error' });
                    }
                    res.json({ success: true, role: user.role });
                });
            } else {
                res.json({ success: false, message: 'Invalid credentials' });
            }
        });
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get customer's account
app.get('/api/my-account', (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Not logged in' });
    }

    db.query('SELECT * FROM accounts WHERE user_id = ?',
        [req.session.userId],
        (err, results) => {
            if (err) {
                return res.json({ success: false, message: 'Database error' });
            }

            if (results.length > 0) {
                // Ensure balance is a number
                const account = results[0];
                account.balance = parseFloat(account.balance);
                res.json({ success: true, account: account });
            } else {
                res.json({ success: false, message: 'No account found' });
            }
        });
});

// ⭐ DEPOSIT - FIXED
app.post('/api/deposit', (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { amount } = req.body;
    const depositAmount = parseFloat(amount);

    if (!depositAmount || depositAmount <= 0) {
        return res.json({ success: false, message: 'Valid amount required' });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.json({ success: false, message: 'Connection error' });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.json({ success: false, message: 'Transaction error' });
            }

            connection.query(
                'SELECT id, account_number, balance FROM accounts WHERE user_id = ? FOR UPDATE',
                [req.session.userId],
                (err, results) => {
                    if (err || results.length === 0) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Account not found' });
                        });
                    }

                    const account = results[0];
                    const currentBalance = parseFloat(account.balance);
                    const newBalance = currentBalance + depositAmount;

                    connection.query(
                        'UPDATE accounts SET balance = ? WHERE id = ?',
                        [newBalance, account.id],
                        (err) => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.json({ success: false, message: 'Deposit failed' });
                                });
                            }

                            connection.query(
                                'INSERT INTO transactions (to_account, amount, type, description) VALUES (?, ?, ?, ?)',
                                [account.account_number, depositAmount, 'DEPOSIT', 'Cash Deposit'],
                                (err) => {
                                    if (err) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            res.json({ success: false, message: 'Log failed' });
                                        });
                                    }

                                    connection.commit(err => {
                                        connection.release();
                                        if (err) {
                                            return res.json({ success: false, message: 'Commit failed' });
                                        }
                                        res.json({ success: true, message: 'Deposit successful', newBalance });
                                    });
                                });
                        });
                });
        });
    });
});

// ⭐ WITHDRAW - FIXED
app.post('/api/withdraw', (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { amount } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
        return res.json({ success: false, message: 'Valid amount required' });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.json({ success: false, message: 'Connection error' });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.json({ success: false, message: 'Transaction error' });
            }

            connection.query(
                'SELECT id, account_number, balance FROM accounts WHERE user_id = ? FOR UPDATE',
                [req.session.userId],
                (err, results) => {
                    if (err || results.length === 0) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Account not found' });
                        });
                    }

                    const account = results[0];
                    const currentBalance = parseFloat(account.balance);

                    // FIXED: Proper balance check
                    if (currentBalance < withdrawAmount) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Insufficient funds' });
                        });
                    }

                    const newBalance = currentBalance - withdrawAmount;

                    connection.query(
                        'UPDATE accounts SET balance = ? WHERE id = ?',
                        [newBalance, account.id],
                        (err) => {
                            if (err) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.json({ success: false, message: 'Withdrawal failed' });
                                });
                            }

                            connection.query(
                                'INSERT INTO transactions (from_account, amount, type, description) VALUES (?, ?, ?, ?)',
                                [account.account_number, withdrawAmount, 'WITHDRAWAL', 'Cash Withdrawal'],
                                (err) => {
                                    if (err) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            res.json({ success: false, message: 'Log failed' });
                                        });
                                    }

                                    connection.commit(err => {
                                        connection.release();
                                        if (err) {
                                            return res.json({ success: false, message: 'Commit failed' });
                                        }
                                        res.json({ success: true, message: 'Withdrawal successful', newBalance });
                                    });
                                });
                        });
                });
        });
    });
});

// ⭐ CUSTOMER TRANSFER - FIXED
app.post('/api/transfer', (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { toAccount, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!toAccount || !transferAmount || transferAmount <= 0) {
        return res.json({ success: false, message: 'All fields required' });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.json({ success: false, message: 'Connection error' });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.json({ success: false, message: 'Transaction error' });
            }

            // Get sender's account
            connection.query(
                'SELECT id, account_number, balance FROM accounts WHERE user_id = ? FOR UPDATE',
                [req.session.userId],
                (err, results) => {
                    if (err || results.length === 0) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Your account not found' });
                        });
                    }

                    const fromAccount = results[0];
                    const currentBalance = parseFloat(fromAccount.balance);

                    // Check if sending to self
                    if (fromAccount.account_number === toAccount) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Cannot transfer to same account' });
                        });
                    }

                    // FIXED: Proper balance check
                    if (currentBalance < transferAmount) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Insufficient funds' });
                        });
                    }

                    // Get receiver's account
                    connection.query(
                        'SELECT id, account_number, balance FROM accounts WHERE account_number = ? FOR UPDATE',
                        [toAccount],
                        (err, results) => {
                            if (err || results.length === 0) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.json({ success: false, message: 'Receiver account not found' });
                                });
                            }

                            const toAccountData = results[0];
                            const receiverBalance = parseFloat(toAccountData.balance);

                            const newFromBalance = currentBalance - transferAmount;
                            const newToBalance = receiverBalance + transferAmount;

                            // Update sender
                            connection.query(
                                'UPDATE accounts SET balance = ? WHERE id = ?',
                                [newFromBalance, fromAccount.id],
                                (err) => {
                                    if (err) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            res.json({ success: false, message: 'Transfer failed' });
                                        });
                                    }

                                    // Update receiver
                                    connection.query(
                                        'UPDATE accounts SET balance = ? WHERE id = ?',
                                        [newToBalance, toAccountData.id],
                                        (err) => {
                                            if (err) {
                                                return connection.rollback(() => {
                                                    connection.release();
                                                    res.json({ success: false, message: 'Transfer failed' });
                                                });
                                            }

                                            // Log transaction
                                            connection.query(
                                                'INSERT INTO transactions (from_account, to_account, amount, type, description) VALUES (?, ?, ?, ?, ?)',
                                                [fromAccount.account_number, toAccount, transferAmount, 'TRANSFER', description || 'Transfer'],
                                                (err) => {
                                                    if (err) {
                                                        return connection.rollback(() => {
                                                            connection.release();
                                                            res.json({ success: false, message: 'Log failed' });
                                                        });
                                                    }

                                                    connection.commit(err => {
                                                        connection.release();
                                                        if (err) {
                                                            return res.json({ success: false, message: 'Commit failed' });
                                                        }
                                                        res.json({ success: true, message: 'Transfer successful', newBalance: newFromBalance });
                                                    });
                                                });
                                        });
                                });
                        });
                });
        });
    });
});

// Get transaction history
app.get('/api/transactions', (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false });
    }

    db.query(
        `SELECT t.* FROM transactions t 
         JOIN accounts a ON (t.from_account = a.account_number OR t.to_account = a.account_number)
         WHERE a.user_id = ?
         ORDER BY t.created_at DESC LIMIT 20`,
        [req.session.userId],
        (err, results) => {
            if (err) {
                return res.json({ success: false });
            }
            res.json({ success: true, transactions: results });
        });
});

// ============ ADMIN ROUTES ============

// Get all customer accounts
app.get('/api/admin/accounts', (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.json({ success: false, message: 'Unauthorized' });
    }

    db.query(
        `SELECT a.*, u.username, u.full_name 
         FROM accounts a 
         JOIN users u ON a.user_id = u.id 
         WHERE u.role = 'customer'
         ORDER BY u.username`,
        (err, results) => {
            if (err) {
                return res.json({ success: false });
            }

            // Ensure balances are numbers
            results.forEach(acc => {
                acc.balance = parseFloat(acc.balance);
            });

            res.json({ success: true, accounts: results });
        });
});

// ⭐ ADMIN TRANSFER - FIXED
app.post('/api/admin/transfer', (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.json({ success: false, message: 'Unauthorized' });
    }

    const { fromAccount, toAccount, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!fromAccount || !toAccount || !transferAmount || transferAmount <= 0) {
        return res.json({ success: false, message: 'All fields required' });
    }

    if (fromAccount === toAccount) {
        return res.json({ success: false, message: 'Cannot transfer to same account' });
    }

    db.getConnection((err, connection) => {
        if (err) {
            return res.json({ success: false, message: 'Connection error' });
        }

        connection.beginTransaction(err => {
            if (err) {
                connection.release();
                return res.json({ success: false, message: 'Transaction error' });
            }

            // Lock and get source account
            connection.query(
                'SELECT id, account_number, balance FROM accounts WHERE account_number = ? FOR UPDATE',
                [fromAccount],
                (err, results) => {
                    if (err || results.length === 0) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Source account not found' });
                        });
                    }

                    const from = results[0];
                    const fromBalance = parseFloat(from.balance);

                    // FIXED: Proper balance check
                    if (fromBalance < transferAmount) {
                        return connection.rollback(() => {
                            connection.release();
                            res.json({ success: false, message: 'Insufficient funds in source account' });
                        });
                    }

                    // Lock and get destination account
                    connection.query(
                        'SELECT id, account_number, balance FROM accounts WHERE account_number = ? FOR UPDATE',
                        [toAccount],
                        (err, results) => {
                            if (err || results.length === 0) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.json({ success: false, message: 'Destination account not found' });
                                });
                            }

                            const to = results[0];
                            const toBalance = parseFloat(to.balance);

                            const newFromBalance = fromBalance - transferAmount;
                            const newToBalance = toBalance + transferAmount;

                            // Update source
                            connection.query(
                                'UPDATE accounts SET balance = ? WHERE id = ?',
                                [newFromBalance, from.id],
                                (err) => {
                                    if (err) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            res.json({ success: false, message: 'Transfer failed' });
                                        });
                                    }

                                    // Update destination
                                    connection.query(
                                        'UPDATE accounts SET balance = ? WHERE id = ?',
                                        [newToBalance, to.id],
                                        (err) => {
                                            if (err) {
                                                return connection.rollback(() => {
                                                    connection.release();
                                                    res.json({ success: false, message: 'Transfer failed' });
                                                });
                                            }

                                            // Log transaction
                                            connection.query(
                                                'INSERT INTO transactions (from_account, to_account, amount, type, description) VALUES (?, ?, ?, ?, ?)',
                                                [fromAccount, toAccount, transferAmount, 'ADMIN_TRANSFER', description || 'Bank Officer Transfer'],
                                                (err) => {
                                                    if (err) {
                                                        return connection.rollback(() => {
                                                            connection.release();
                                                            res.json({ success: false, message: 'Log failed' });
                                                        });
                                                    }

                                                    connection.commit(err => {
                                                        connection.release();
                                                        if (err) {
                                                            return res.json({ success: false, message: 'Commit failed' });
                                                        }
                                                        res.json({ success: true, message: 'Transfer successful' });
                                                    });
                                                });
                                        });
                                });
                        });
                });
        });
    });
});

// Start server
app.listen(3000, () => {
    console.log('🏦 BankCore running at http://localhost:3000');
    console.log('📝 Admin: admin1/admin123 | Customer: john/123456');
});