const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg'); // PostgreSQL
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 🗄️ 데이터베이스 연결
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 🛡️ 보안 미들웨어
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 100 // 최대 100개 요청
});

app.use(limiter);
app.use(express.json());
app.use(express.static('public'));

// 📁 파일 업로드 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp3|wav|ogg|m4a|webm/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('Invalid file type'));
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: fileFilter
});

// 🔐 JWT 인증 미들웨어
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid token' });
        }

        req.user = userResult.rows[0];
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// 📊 사용자 구독 상태 확인
const checkSubscription = async (req, res, next) => {
    try {
        const subscriptionResult = await pool.query(`
            SELECT us.*, sp.name as plan_name, sp.max_conversion_time, sp.max_output_per_batch
            FROM user_subscriptions us
            JOIN subscription_plans sp ON us.plan_id = sp.id
            WHERE us.user_id = $1 AND us.is_active = true AND us.expires_at > NOW()
            ORDER BY us.expires_at DESC
            LIMIT 1
        `, [req.user.id]);

        if (subscriptionResult.rows.length === 0) {
            return res.status(403).json({ 
                error: 'No active subscription',
                message: 'Please upgrade your plan to access this feature'
            });
        }

        req.subscription = subscriptionResult.rows[0];
        next();
    } catch (error) {
        console.error('Subscription check error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// 🏠 메인 페이지
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 👤 사용자 등록
app.post('/api/register', async (req, res) => {
    try {
        const { email, name, phone, nickname, password, marketing = false } = req.body;
        
        // 이메일 중복 체크
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // 비밀번호 해싱
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 사용자 생성
        const result = await pool.query(`
            INSERT INTO users (id, email, name, phone, nickname, password, marketing, admin, created_at, updated_at)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, false, NOW(), NOW())
            RETURNING id, email, name, nickname, profile, created_at
        `, [email, name, phone, nickname, hashedPassword, marketing]);

        const user = result.rows[0];

        // 기본 무료 플랜 할당
        const freePlan = await pool.query('SELECT id FROM subscription_plans WHERE name = $1', ['BASIC']);
        if (freePlan.rows.length > 0) {
            await pool.query(`
                INSERT INTO user_subscriptions (user_id, plan_id, started_at, expires_at, is_active)
                VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 year', true)
            `, [user.id, freePlan.rows[0].id]);
        }

        res.status(201).json({
            message: 'User created successfully',
            user: user
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 🔑 사용자 로그인
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const result = await pool.query(`
            SELECT u.*, us.plan_id, sp.name as plan_name
            FROM users u
            LEFT JOIN user_subscriptions us ON u.id = us.user_id AND us.is_active = true AND us.expires_at > NOW()
            LEFT JOIN subscription_plans sp ON us.plan_id = sp.id
            WHERE u.email = $1
            ORDER BY us.expires_at DESC
            LIMIT 1
        `, [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const isValidPassword = await bcrypt.compare(password, user.password);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                nickname: user.nickname,
                profile: user.profile,
                admin: user.admin,
                plan_name: user.plan_name || 'BASIC'
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 📊 구독 플랜 목록
app.get('/api/plans', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, price_usd, max_conversion_time, max_output_per_batch
            FROM subscription_plans
            ORDER BY CASE name 
                WHEN 'BASIC' THEN 1 
                WHEN 'PRO' THEN 2 
                WHEN 'VIP' THEN 3 
                ELSE 4 
            END
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Plans fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 💎 구독 업그레이드
app.post('/api/subscribe', authenticateToken, async (req, res) => {
    try {
        const { plan_id } = req.body;
        
        // 현재 구독 비활성화
        await pool.query(`
            UPDATE user_subscriptions 
            SET is_active = false, updated_at = NOW()
            WHERE user_id = $1 AND is_active = true
        `, [req.user.id]);

        // 새 구독 생성
        const result = await pool.query(`
            INSERT INTO user_subscriptions (user_id, plan_id, started_at, expires_at, is_active)
            VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 month', true)
            RETURNING *
        `, [req.user.id, plan_id]);

        res.json({
            message: 'Subscription updated successfully',
            subscription: result.rows[0]
        });
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 📁 파일 업로드 (구독자만)
app.post('/upload', authenticateToken, checkSubscription, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    }
    
    const downloadDisabled = req.body.downloadDisabled === 'true';
    
    console.log('📁 File uploaded by:', req.user.nickname, req.file.filename);
    res.json({
        success: true,
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`,
        downloadDisabled: downloadDisabled,
        uploader: req.user.nickname
    });
});

// 💬 실시간 채팅 (구독 제한 적용)
io.on('connection', (socket) => {
    console.log('🔌 User connected:', socket.id);

    // 🏠 방 참여 (구독 상태 확인)
    socket.on('join room', async (data) => {
        try {
            // JWT 토큰 검증 (실제로는 socket 인증 미들웨어 필요)
            const { roomName, token } = data;
            
            if (token) {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
                
                if (userResult.rows.length > 0) {
                    socket.user = userResult.rows[0];
                    
                    // 구독 상태 확인
                    const subscriptionResult = await pool.query(`
                        SELECT sp.max_output_per_batch
                        FROM user_subscriptions us
                        JOIN subscription_plans sp ON us.plan_id = sp.id
                        WHERE us.user_id = $1 AND us.is_active = true AND us.expires_at > NOW()
                        LIMIT 1
                    `, [socket.user.id]);

                    if (subscriptionResult.rows.length > 0) {
                        const maxUsers = subscriptionResult.rows[0].max_output_per_batch;
                        const roomUsers = Array.from(io.sockets.adapter.rooms.get(roomName) || []);
                        
                        if (roomUsers.length >= maxUsers) {
                            socket.emit('room full', { 
                                message: `Room is full. Upgrade your plan to join rooms with more than ${maxUsers} users.` 
                            });
                            return;
                        }
                    }
                }
            }

            socket.join(roomName);
            socket.currentRoom = roomName;
            
            const roomUsers = Array.from(io.sockets.adapter.rooms.get(roomName) || []);
            io.to(roomName).emit('user count', roomUsers.length);
            
            console.log(`👤 ${socket.user?.nickname || 'Anonymous'} joined room: ${roomName}`);
        } catch (error) {
            console.error('Join room error:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    // 💬 메시지 전송
    socket.on('chat message', (data) => {
        if (socket.currentRoom && socket.user) {
            const messageData = {
                username: socket.user.nickname || socket.user.name,
                message: data.message,
                fileData: data.fileData,
                timestamp: new Date().toISOString(),
                userId: socket.user.id,
                userPlan: socket.user.plan_name || 'BASIC'
            };

            io.to(socket.currentRoom).emit('chat message', messageData);
            console.log(`💬 Message in ${socket.currentRoom}:`, messageData.username, messageData.message);
        }
    });

    socket.on('disconnect', () => {
        if (socket.currentRoom) {
            const roomUsers = Array.from(io.sockets.adapter.rooms.get(socket.currentRoom) || []);
            io.to(socket.currentRoom).emit('user count', roomUsers.length);
        }
        console.log('❌ User disconnected:', socket.id);
    });
});

// 📁 업로드된 파일 서빙
app.use('/uploads', express.static('uploads'));

// 📥 파일 다운로드
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, 'uploads', filename);
    
    if (fs.existsSync(filepath)) {
        res.download(filepath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 VVCKD ROOM Server running on http://localhost:${PORT}`);
});

// 🗄️ 데이터베이스 초기화 (첫 실행 시)
async function initializeDatabase() {
    try {
        // 기본 구독 플랜 생성
        await pool.query(`
            INSERT INTO subscription_plans (name, price_usd, max_conversion_time, max_output_per_batch)
            VALUES 
                ('BASIC', '$0', 300, 10),
                ('PRO', '$9.99', 3600, 100),
                ('VIP', '$29.99', -1, 1000)
            ON CONFLICT (name) DO NOTHING
        `);
        
        console.log('✅ Database initialized');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

initializeDatabase();