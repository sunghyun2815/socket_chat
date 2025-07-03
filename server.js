const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// uploads 폴더 생성
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// music 폴더 생성 (음악 파일 전용)
const musicDir = path.join(__dirname, 'uploads', 'music');
if (!fs.existsSync(musicDir)) {
    fs.mkdirSync(musicDir);
}

// Multer 설정 (일반 파일 업로드 - 채팅용)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const timestamp = Date.now();
        cb(null, timestamp + '_' + file.originalname);
    }
});

// Multer 설정 (음악 파일 업로드)
const musicStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/music/');
    },
    filename: function (req, file, cb) {
        const timestamp = Date.now();
        cb(null, timestamp + '_' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB 제한으로 증가
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|mp3|wav|ogg|m4a|webm|flac|aac|mpeg/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype) || 
                         file.mimetype.startsWith('audio/') || 
                         file.mimetype.startsWith('image/');
        
        console.log('📁 File check:', {
            filename: file.originalname,
            mimetype: file.mimetype,
            extname: path.extname(file.originalname),
            extensionMatch: extname,
            mimetypeMatch: mimetype
        });
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            const errorMsg = `Error: 지원하지 않는 파일 형식입니다. (업로드 시도: ${file.originalname}, MIME: ${file.mimetype})`;
            console.error('❌ File rejected:', errorMsg);
            cb(errorMsg);
        }
    }
});

const musicUpload = multer({
    storage: musicStorage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB 제한
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /mp3|wav|ogg|m4a|webm|flac|aac|mpeg/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype) || file.mimetype.startsWith('audio/');
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb('Error: 음원 파일(mp3, wav, ogg, m4a, webm, flac, aac)만 업로드 가능합니다!');
        }
    }
});

// 정적 파일 제공
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// 기존 파일 업로드 라우트 (채팅용)
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        console.error('❌ No file uploaded');
        return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    }
    
    const downloadDisabled = req.body.downloadDisabled === 'true';
    
    console.log('📁 File uploaded successfully:', {
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        downloadDisabled: downloadDisabled
    });
    
    res.json({
        success: true,
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`,
        downloadDisabled: downloadDisabled
    });
});

// 음악 파일 업로드 라우트
app.post('/upload/music', musicUpload.single('musicFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '음악 파일이 업로드되지 않았습니다.' });
    }
    
    const { roomName, uploader } = req.body;
    
    console.log('🎵 Music uploaded:', req.file.filename, 'to room:', roomName, 'by:', uploader);
    res.json({
        success: true,
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        url: `/uploads/music/${req.file.filename}`,
        roomName: roomName,
        uploader: uploader,
        uploadTime: Date.now()
    });
});

// 파일 다운로드 라우트
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    
    const originalName = filename.substring(filename.indexOf('_') + 1);
    console.log('📥 File download requested:', filename, '→', originalName);
    
    res.download(filePath, originalName, (err) => {
        if (err) {
            console.error('❌ Download error:', err);
            res.status(500).json({ error: '파일 다운로드 중 오류가 발생했습니다.' });
        } else {
            console.log('✅ File downloaded successfully:', originalName);
        }
    });
});

// 음악 파일 스트리밍 라우트
app.get('/stream/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads/music', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '음악 파일을 찾을 수 없습니다.' });
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'audio/mpeg',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'audio/mpeg',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// 에러 핸들링 미들웨어
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        console.error('❌ Multer error:', error);
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: '파일 크기가 너무 큽니다. (최대 50MB)' });
        }
        return res.status(400).json({ error: '파일 업로드 오류: ' + error.message });
    }
    
    if (error) {
        console.error('❌ General error:', error);
        return res.status(400).json({ error: error.message || '알 수 없는 오류가 발생했습니다.' });
    }
    
    next();
});

// 방 정보 저장 (채팅룸)
const rooms = new Map();

// 음악룸 정보 저장
const musicRooms = new Map();

io.on('connection', (socket) => {
    console.log('✅ 사용자 연결:', socket.id);
    
    let currentUser = '';
    let currentRoom = '';
    let currentMusicRoom = '';

    // 사용자 참가
    socket.on('user join', (data) => {
        currentUser = data.username;
        console.log(`👤 ${currentUser} joined`);
        socket.emit('test message', 'Server connection successful!');
    });

    // === 기존 채팅룸 기능들 ===
    
    // 방 목록 요청
    socket.on('get room list', () => {
        const roomList = Array.from(rooms.values()).map(room => ({
            name: room.name,
            userCount: room.users.size,
            maxUsers: room.maxUsers,
            hasPassword: !!room.password,
            creator: room.creator,
            lastMessage: room.messages.length > 0 ? 
                room.messages[room.messages.length - 1].message : null,
            lastMessageTime: room.messages.length > 0 ? 
                room.messages[room.messages.length - 1].timestamp : room.createdAt
        }));
        
        socket.emit('room list', roomList);
    });

    // 방 생성
    socket.on('create room', (data) => {
        const { roomName, maxUsers, password } = data;
        
        if (!rooms.has(roomName)) {
            rooms.set(roomName, {
                name: roomName,
                users: new Set(),
                messages: [],
                maxUsers: maxUsers || null,
                password: password || null,
                creator: currentUser,
                createdAt: Date.now()
            });
            
            const passwordInfo = password ? ' (비밀번호 보호)' : '';
            console.log(`🏠 방 생성: ${roomName} (최대 ${maxUsers || '∞'}명)${passwordInfo}`);
            socket.emit('room created', { 
                roomName, 
                maxUsers,
                hasPassword: !!password
            });
        } else {
            socket.emit('room join error', { message: '이미 존재하는 방 이름입니다.' });
        }
    });

    // 방 참가
    socket.on('join room', (data) => {
        const { roomName, password } = data;
        const room = rooms.get(roomName);
        
        if (!room) {
            socket.emit('room join error', { message: '존재하지 않는 방입니다.' });
            return;
        }

        if (room.password && room.creator !== currentUser) {
            if (!password || password !== room.password) {
                socket.emit('room join error', { message: '비밀번호가 틀렸습니다.' });
                return;
            }
        }

        if (room.maxUsers && room.users.size >= room.maxUsers) {
            socket.emit('room join error', { message: `방이 가득 찼습니다. (${room.maxUsers}/${room.maxUsers})` });
            return;
        }

        if (currentRoom) {
            const prevRoom = rooms.get(currentRoom);
            if (prevRoom) {
                prevRoom.users.delete(socket.id);
                socket.leave(currentRoom);
                socket.to(currentRoom).emit('user left room', {
                    username: currentUser,
                    userCount: prevRoom.users.size
                });
            }
        }

        currentRoom = roomName;
        room.users.add(socket.id);
        socket.join(roomName);
        
        console.log(`🚀 ${currentUser} joined room: ${roomName} (${room.users.size}/${room.maxUsers || '∞'})`);
        
        socket.emit('room join success', { 
            roomName, 
            userCount: room.users.size,
            maxUsers: room.maxUsers 
        });
        
        socket.to(roomName).emit('user joined room', {
            username: currentUser,
            userCount: room.users.size
        });
        
        socket.emit('room user count', { 
            count: room.users.size,
            maxUsers: room.maxUsers 
        });
        
        room.messages.forEach(message => {
            socket.emit('chat message', {
                ...message,
                isPrevious: true
            });
        });
    });

    // 방 나가기
    socket.on('leave room', (data) => {
        const { roomName } = data;
        const room = rooms.get(roomName);
        
        if (room && room.users.has(socket.id)) {
            room.users.delete(socket.id);
            socket.leave(roomName);
            
            console.log(`👋 ${currentUser} left room: ${roomName}`);
            
            socket.to(roomName).emit('user left room', {
                username: currentUser,
                userCount: room.users.size
            });
        }
        
        currentRoom = '';
    });

    // 채팅 메시지
    socket.on('chat message', (data) => {
        const { roomName, message, fileData } = data;
        const room = rooms.get(roomName);
        
        if (room && room.users.has(socket.id)) {
            const messageData = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                username: currentUser,
                message: message,
                fileData: fileData || null,
                timestamp: new Date().toISOString(),
                isPrevious: false
            };
            
            room.messages.push(messageData);
            
            if (room.messages.length > 100) {
                room.messages = room.messages.slice(-100);
            }
            
            const logMessage = fileData ? 
                `💬 [${roomName}] ${currentUser}: [파일: ${fileData.originalname}]` :
                `💬 [${roomName}] ${currentUser}: ${message}`;
            console.log(logMessage);
            
            io.to(roomName).emit('chat message', messageData);
        }
    });

    // 메시지 삭제
    socket.on('delete message', (data) => {
        const { roomName, messageId } = data;
        const room = rooms.get(roomName);
        
        if (!room || !room.users.has(socket.id)) {
            socket.emit('delete error', { message: '권한이 없습니다.' });
            return;
        }

        const messageIndex = room.messages.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) {
            socket.emit('delete error', { message: '메시지를 찾을 수 없습니다.' });
            return;
        }

        const message = room.messages[messageIndex];
        
        if (message.username !== currentUser) {
            socket.emit('delete error', { message: '본인이 작성한 메시지만 삭제할 수 있습니다.' });
            return;
        }

        if (message.fileData && message.fileData.filename) {
            const filePath = path.join(__dirname, 'uploads', message.fileData.filename);
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error('❌ 파일 삭제 실패:', err);
                } else {
                    console.log('🗑️ 파일 삭제됨:', message.fileData.filename);
                }
            });
        }

        room.messages.splice(messageIndex, 1);
        
        console.log(`🗑️ [${roomName}] ${currentUser} deleted message: ${messageId}`);
        
        io.to(roomName).emit('message deleted', { messageId });
        socket.emit('delete success', { messageId });
    });

    // === 음악룸 기능들 (클라이언트 코드와 매칭) ===

    // 음악룸 목록 요청
    socket.on('get music room list', () => {
        const musicRoomList = Array.from(musicRooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            description: room.description,
            participants: room.users.size,
            musicCount: room.playlist.length,
            maxUsers: room.maxUsers,
            status: room.users.size > 0 ? 'active' : 'inactive',
            creator: room.creator,
            genres: room.genres,
            currentTrack: room.currentTrack,
            isPlaying: room.isPlaying,
            createdAt: room.createdAt
        }));
        
        console.log('📋 Sending music room list:', musicRoomList);
        socket.emit('music room list', musicRoomList);
    });

    // 음악룸 생성
    socket.on('create music room', (data) => {
        const { roomName, description, maxUsers, genres, type } = data;
        const roomId = roomName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
        
        if (!musicRooms.has(roomId)) {
            const newRoom = {
                id: roomId,
                name: roomName,
                description: description || 'Collaborative music workspace',
                users: new Set(),
                maxUsers: maxUsers || 10,
                creator: currentUser,
                genres: genres || ['Electronic', 'Hip-Hop', 'Rock'],
                playlist: [],
                currentTrack: null,
                currentTrackIndex: 0,
                isPlaying: false,
                playStartTime: null,
                messages: [],
                votes: new Map(),
                createdAt: Date.now()
            };
            
            musicRooms.set(roomId, newRoom);
            
            console.log(`🎵 음악룸 생성: ${roomName} (최대 ${maxUsers}명) by ${currentUser}`);
            
            // 방 생성자에게 즉시 생성된 방 정보 전송
            socket.emit('music room created', {
                id: roomId,
                name: roomName,
                description: newRoom.description,
                participants: 0,
                musicCount: 0,
                maxUsers: maxUsers || 10,
                status: 'active',
                creator: currentUser,
                genres: newRoom.genres,
                createdAt: newRoom.createdAt
            });
            
            // 방 생성자에게 업데이트된 방 목록 즉시 전송
            const musicRoomList = Array.from(musicRooms.values()).map(room => ({
                id: room.id,
                name: room.name,
                description: room.description,
                participants: room.users.size,
                musicCount: room.playlist.length,
                maxUsers: room.maxUsers,
                status: room.users.size > 0 ? 'active' : 'inactive',
                creator: room.creator,
                genres: room.genres,
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying,
                createdAt: room.createdAt
            }));
            
            socket.emit('music room list', musicRoomList);
            
            // 다른 모든 클라이언트에게 방 목록 업데이트 알림
            socket.broadcast.emit('music room list update');
        } else {
            socket.emit('music room join error', { message: '이미 존재하는 음악룸 이름입니다.' });
        }
    });

    // 음악룸 참가
    socket.on('join music room', (data) => {
        const { roomId } = data;
        const room = musicRooms.get(roomId);
        
        if (!room) {
            socket.emit('music room join error', { message: '존재하지 않는 음악룸입니다.' });
            return;
        }

        if (room.users.size >= room.maxUsers) {
            socket.emit('music room join error', { message: `음악룸이 가득 찼습니다. (${room.maxUsers}/${room.maxUsers})` });
            return;
        }

        // 이전 음악룸에서 나가기
        if (currentMusicRoom) {
            const prevRoom = musicRooms.get(currentMusicRoom);
            if (prevRoom) {
                prevRoom.users.delete(socket.id);
                socket.leave(currentMusicRoom);
                socket.to(currentMusicRoom).emit('music room user left', {
                    username: currentUser,
                    userCount: prevRoom.users.size
                });
            }
        }

        // 새 음악룸 참가
        currentMusicRoom = roomId;
        room.users.add(socket.id);
        socket.join(roomId);
        
        console.log(`🎵 ${currentUser} joined music room: ${room.name} (${room.users.size}/${room.maxUsers})`);
        
        // 음악룸 참가 성공 알림
        socket.emit('music room join success', { 
            roomId,
            roomName: room.name,
            userCount: room.users.size,
            maxUsers: room.maxUsers,
            currentTrack: room.currentTrack,
            isPlaying: room.isPlaying,
            playlist: room.playlist
        });
        
        // 다른 사용자들에게 알림
        socket.to(roomId).emit('music room user joined', {
            username: currentUser,
            userCount: room.users.size
        });
        
        // 이전 채팅 메시지들 전송
        room.messages.forEach(message => {
            socket.emit('music chat message', {
                ...message,
                isPrevious: true
            });
        });
    });

    // 음악룸 나가기
    socket.on('leave music room', (data) => {
        const { roomId } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            room.users.delete(socket.id);
            socket.leave(roomId);
            
            console.log(`👋 ${currentUser} left music room: ${room.name}`);
            
            socket.to(roomId).emit('music room user left', {
                username: currentUser,
                userCount: room.users.size
            });
        }
        
        currentMusicRoom = '';
    });

    // 음악룸 채팅 메시지
    socket.on('music chat message', (data) => {
        const { roomId, message, user, timestamp } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            const messageData = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                roomId: roomId,
                user: user || currentUser,
                message: message,
                timestamp: timestamp || Date.now(),
                time: new Date().toISOString(),
                isPrevious: false
            };
            
            room.messages.push(messageData);
            
            // 메시지 개수 제한
            if (room.messages.length > 100) {
                room.messages = room.messages.slice(-100);
            }
            
            console.log(`💬 [Music Room: ${room.name}] ${currentUser}: ${message}`);
            
            // 룸의 모든 사용자에게 전송
            io.to(roomId).emit('music chat message', messageData);
        }
    });

    // 음성 메시지 (음악룸)
    socket.on('music voice message', (data) => {
        const { roomId, user, timestamp, audioUrl } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            const voiceData = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                roomId: roomId,
                user: user || currentUser,
                timestamp: timestamp || Date.now(),
                audioUrl: audioUrl,
                time: new Date().toISOString(),
                isPrevious: false
            };
            
            room.messages.push(voiceData);
            
            console.log(`🎤 [Music Room: ${room.name}] ${currentUser}: voice message`);
            
            // 룸의 모든 사용자에게 전송
            io.to(roomId).emit('music chat message', voiceData);
        }
    });

    // 음악 업로드 및 플레이리스트 추가
    socket.on('music uploaded', (data) => {
        const { roomId, musicData } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            const trackData = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                title: musicData.originalname.replace(/\.[^/.]+$/, ""),
                filename: musicData.filename,
                originalname: musicData.originalname,
                url: musicData.url,
                uploader: currentUser,
                uploadTime: Date.now(),
                duration: '0:00',
                votes: 0,
                voters: new Set()
            };
            
            room.playlist.push(trackData);
            
            console.log(`🎵 Music added to ${room.name}: ${trackData.title} by ${currentUser}`);
            
            // 플레이리스트 업데이트
            io.to(roomId).emit('playlist update', { 
                playlist: room.playlist,
                currentTrack: room.currentTrack,
                isPlaying: room.isPlaying
            });
            
            // 시스템 메시지 추가
            const systemMessage = {
                id: Date.now() + '_system',
                type: 'system',
                user: 'SYSTEM',
                message: `${currentUser} uploaded "${trackData.title}"`,
                timestamp: Date.now(),
                time: new Date().toISOString()
            };
            
            room.messages.push(systemMessage);
            io.to(roomId).emit('music chat message', systemMessage);
        }
    });

    // 트랙 재생 제어
    socket.on('play track', (data) => {
        const { roomId, trackId } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            const track = room.playlist.find(t => t.id === trackId);
            if (track) {
                room.currentTrack = track;
                room.isPlaying = true;
                room.playStartTime = Date.now();
                
                console.log(`▶️ Now playing in ${room.name}: ${track.title}`);
                
                io.to(roomId).emit('track changed', {
                    currentTrack: track,
                    isPlaying: true,
                    playStartTime: room.playStartTime
                });
            }
        }
    });

    // 재생/일시정지 토글
    socket.on('toggle playback', (data) => {
        const { roomId } = data;
        const room = musicRooms.get(roomId);
        
        if (room && room.users.has(socket.id)) {
            room.isPlaying = !room.isPlaying;
            
            if (room.isPlaying) {
                room.playStartTime = Date.now();
            }
            
            console.log(`${room.isPlaying ? '▶️' : '⏸️'} Playback ${room.isPlaying ? 'resumed' : 'paused'} in ${room.name}`);
            
            io.to(roomId).emit('playback toggled', {
                isPlaying: room.isPlaying,
                playStartTime: room.playStartTime
            });
        }
    });

    // 연결 해제
    socket.on('disconnect', () => {
        console.log('❌ 사용자 연결 해제:', socket.id);
        
        // 현재 채팅룸에서 사용자 제거
        if (currentRoom) {
            const room = rooms.get(currentRoom);
            if (room) {
                room.users.delete(socket.id);
                socket.to(currentRoom).emit('user left room', {
                    username: currentUser,
                    userCount: room.users.size
                });
            }
        }
        
        // 현재 음악룸에서 사용자 제거
        if (currentMusicRoom) {
            const room = musicRooms.get(currentMusicRoom);
            if (room) {
                room.users.delete(socket.id);
                socket.to(currentMusicRoom).emit('music room user left', {
                    username: currentUser,
                    userCount: room.users.size
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`);
    console.log(`📱 브라우저에서 http://localhost:${PORT} 접속하세요.`);
    console.log(`🎵 Music Room 기능이 활성화되었습니다!`);
});
