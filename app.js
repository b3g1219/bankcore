const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');

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

// ============ DATABASE CONNECTION ============
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ============ AUTO-CREATE TABLES ============
async function initializeDatabase() {
    try {
        // Create users table
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(100),
                role VARCHAR(20) DEFAULT 'customer',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create accounts table
        await db.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                user_id INT UNIQUE NOT NULL,
                account_number VARCHAR(20) UNIQUE NOT NULL,
                balance DECIMAL(15,2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create transactions table
        await db.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                from_account VARCHAR(20),
                to_account VARCHAR(20),
                amount DECIMAL(15,2) NOT NULL,
                type VARCHAR(30) NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Check if users exist
        const userCount = await db.query('SELECT COUNT(*) FROM users');
        if (parseInt(userCount.rows[0].count) === 0) {
            // Insert default users
            await db.query(`
                INSERT INTO users (username, password, full_name, role) VALUES
                ('admin1', 'admin123', 'Bank Officer One', 'admin'),
                ('admin2', 'admin123', 'Bank Officer Two', 'admin'),
                ('john', '123456', 'John Doe', 'customer'),
                ('sarah', '123456', 'Sarah Smith', 'customer'),
                ('mike', '123456', 'Mike Johnson', 'customer'),
                ('emma', '123456', 'Emma Wilson', 'customer')
            `);
            console.log('✅ Default users created');
        }

        // Check if accounts exist
        const accountCount = await db.query('SELECT COUNT(*) FROM accounts');
        if (parseInt(accountCount.rows[0].count) === 0) {
            await db.query(`
                INSERT INTO accounts (user_id, account_number, balance) VALUES
                (3, 'ACC1001', 5000.00),
                (4, 'ACC2001', 7500.00),
                (5, 'ACC3001', 3200.00),
                (6, 'ACC4001', 8800.00)
            `);
            console.log('✅ Default accounts created');
        }

        console.log('✅ Database initialized successfully!');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
    }
}

// Initialize database on startup
initializeDatabase();

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

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const result = await db.query(
            'SELECT * FROM users WHERE username = $1 AND password = $2',
            [username, password]
        );

        if (result.rows.length > 0) {
            const user = result.rows[0];
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            await req.session.save();
            res.json({ success: true, role: user.role });
        } else {
            res.json({ success: false, message: 'Invalid credentials' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.json({ success: false, message: 'Database error' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Get customer's account
app.get('/api/my-account', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Not logged in' });
    }

    try {
        const result = await db.query(
            'SELECT * FROM accounts WHERE user_id = $1',
            [req.session.userId]
        );

        if (result.rows.length > 0) {
            const account = result.rows[0];
            account.balance = parseFloat(account.balance);
            res.json({ success: true, account: account });
        } else {
            res.json({ success: false, message: 'No account found' });
        }
    } catch (err) {
        res.json({ success: false, message: 'Database error' });
    }
});

// Deposit
app.post('/api/deposit', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { amount } = req.body;
    const depositAmount = parseFloat(amount);

    if (!depositAmount || depositAmount <= 0) {
        return res.json({ success: false, message: 'Valid amount required' });
    }

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const accountResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE user_id = $1 FOR UPDATE',
            [req.session.userId]
        );

        if (accountResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Account not found' });
        }

        const account = accountResult.rows[0];
        const currentBalance = parseFloat(account.balance);
        const newBalance = currentBalance + depositAmount;

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [newBalance, account.id]
        );

        await client.query(
            'INSERT INTO transactions (to_account, amount, type, description) VALUES ($1, $2, $3, $4)',
            [account.account_number, depositAmount, 'DEPOSIT', 'Cash Deposit']
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Deposit successful', newBalance });

    } catch (err) {
        await client.query('ROLLBACK');
        res.json({ success: false, message: 'Deposit failed' });
    } finally {
        client.release();
    }
});

// Withdraw
app.post('/api/withdraw', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { amount } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
        return res.json({ success: false, message: 'Valid amount required' });
    }

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const accountResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE user_id = $1 FOR UPDATE',
            [req.session.userId]
        );

        if (accountResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Account not found' });
        }

        const account = accountResult.rows[0];
        const currentBalance = parseFloat(account.balance);

        if (currentBalance < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Insufficient funds' });
        }

        const newBalance = currentBalance - withdrawAmount;

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [newBalance, account.id]
        );

        await client.query(
            'INSERT INTO transactions (from_account, amount, type, description) VALUES ($1, $2, $3, $4)',
            [account.account_number, withdrawAmount, 'WITHDRAWAL', 'Cash Withdrawal']
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Withdrawal successful', newBalance });

    } catch (err) {
        await client.query('ROLLBACK');
        res.json({ success: false, message: 'Withdrawal failed' });
    } finally {
        client.release();
    }
});

// Transfer
app.post('/api/transfer', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false, message: 'Please login first' });
    }

    const { toAccount, amount, description } = req.body;
    const transferAmount = parseFloat(amount);

    if (!toAccount || !transferAmount || transferAmount <= 0) {
        return res.json({ success: false, message: 'All fields required' });
    }

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const fromResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE user_id = $1 FOR UPDATE',
            [req.session.userId]
        );

        if (fromResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Your account not found' });
        }

        const fromAccount = fromResult.rows[0];
        const currentBalance = parseFloat(fromAccount.balance);

        if (fromAccount.account_number === toAccount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Cannot transfer to same account' });
        }

        if (currentBalance < transferAmount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Insufficient funds' });
        }

        const toResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE account_number = $1 FOR UPDATE',
            [toAccount]
        );

        if (toResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Receiver account not found' });
        }

        const toAccountData = toResult.rows[0];
        const receiverBalance = parseFloat(toAccountData.balance);

        const newFromBalance = currentBalance - transferAmount;
        const newToBalance = receiverBalance + transferAmount;

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [newFromBalance, fromAccount.id]
        );

        await client.query(
            'UPDATE accounts SET balance = $1 WHERE id = $2',
            [newToBalance, toAccountData.id]
        );

        await client.query(
            'INSERT INTO transactions (from_account, to_account, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
            [fromAccount.account_number, toAccount, transferAmount, 'TRANSFER', description || 'Transfer']
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Transfer successful', newBalance: newFromBalance });

    } catch (err) {
        await client.query('ROLLBACK');
        res.json({ success: false, message: 'Transfer failed' });
    } finally {
        client.release();
    }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ success: false });
    }

    try {
        const result = await db.query(
            `SELECT t.* FROM transactions t 
             JOIN accounts a ON (t.from_account = a.account_number OR t.to_account = a.account_number)
             WHERE a.user_id = $1
             ORDER BY t.created_at DESC LIMIT 20`,
            [req.session.userId]
        );
        res.json({ success: true, transactions: result.rows });
    } catch (err) {
        res.json({ success: false });
    }
});

// Admin: Get all accounts
app.get('/api/admin/accounts', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.json({ success: false, message: 'Unauthorized' });
    }

    try {
        const result = await db.query(
            `SELECT a.*, u.username, u.full_name 
             FROM accounts a 
             JOIN users u ON a.user_id = u.id 
             WHERE u.role = 'customer'
             ORDER BY u.username`
        );

        result.rows.forEach(acc => {
            acc.balance = parseFloat(acc.balance);
        });

        res.json({ success: true, accounts: result.rows });
    } catch (err) {
        res.json({ success: false });
    }
});

// Admin transfer
app.post('/api/admin/transfer', async (req, res) => {
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

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const fromResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE account_number = $1 FOR UPDATE',
            [fromAccount]
        );

        if (fromResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Source account not found' });
        }

        const from = fromResult.rows[0];
        const fromBalance = parseFloat(from.balance);

        if (fromBalance < transferAmount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Insufficient funds' });
        }

        const toResult = await client.query(
            'SELECT id, account_number, balance FROM accounts WHERE account_number = $1 FOR UPDATE',
            [toAccount]
        );

        if (toResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, message: 'Destination account not found' });
        }

        const to = toResult.rows[0];
        const toBalance = parseFloat(to.balance);

        const newFromBalance = fromBalance - transferAmount;
        const newToBalance = toBalance + transferAmount;

        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newFromBalance, from.id]);
        await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [newToBalance, to.id]);

        await client.query(
            'INSERT INTO transactions (from_account, to_account, amount, type, description) VALUES ($1, $2, $3, $4, $5)',
            [fromAccount, toAccount, transferAmount, 'ADMIN_TRANSFER', description || 'Bank Officer Transfer']
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Transfer successful' });

    } catch (err) {
        await client.query('ROLLBACK');
        res.json({ success: false, message: 'Transfer failed' });
    } finally {
        client.release();
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🏦 BankCore running on port ${PORT}`);
});