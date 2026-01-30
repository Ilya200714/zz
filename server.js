const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ЖЕСТКО отключаем ВСЕ заголовки безопасности Railway
app.disable('x-powered-by');

// Middleware для удаления ВСЕХ security headers
app.use((req, res, next) => {
    // Удаляем все стандартные заголовки безопасности
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-XSS-Protection');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    
    // Разрешаем ВСЕ
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    // Позволяем всё
    res.setHeader('Content-Security-Policy', 
        "default-src * blob: data: 'unsafe-inline' 'unsafe-eval' 'unsafe-hashes'; " +
        "script-src * blob: data: 'unsafe-inline' 'unsafe-eval' 'unsafe-hashes'; " +
        "style-src * blob: data: 'unsafe-inline' 'unsafe-eval'; " +
        "img-src * blob: data: 'unsafe-inline' 'unsafe-eval'; " +
        "media-src * blob: data:; " +
        "font-src * blob: data:; " +
        "connect-src * blob: data: ws: wss:; " +
        "frame-src * blob: data:; " +
        "object-src * blob: data:; " +
        "worker-src * blob: data:;"
    );
    
    next();
});

// Раздаем статические файлы с правильными заголовками
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        res.setHeader('Content-Type', getContentType(path));
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
}));

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml'
    };
    return types[ext] || 'application/octet-stream';
}

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint для проверки
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        rooms: Object.keys(rooms || {}).length 
    });
});

// Запускаем HTTP сервер
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('🔥 Server запущен на порту', PORT);
    console.log('📡 WebSocket сервер готов');
    console.log('🌐 Откройте: http://localhost:' + PORT);
});

// WebSocket сервер
const wss = new WebSocket.Server({ 
    server,
    // Разрешаем все подключения
    verifyClient: (info, callback) => {
        callback(true); // Всегда разрешаем
    }
});

const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log('🟢 Новое подключение от', ip);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'join':
                    handleJoin(ws, data);
                    break;
                case 'signal':
                    handleSignal(ws, data);
                    break;
                case 'message':
                    handleMessage(ws, data);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                case 'leave':
                    handleLeave(ws);
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error);
        }
    });
    
    ws.on('close', () => {
        handleLeave(ws);
        console.log('🔴 Отключился', ip);
    });
    
    ws.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
    
    // Отправляем приветствие
    ws.send(JSON.stringify({
        type: 'hello',
        message: 'Подключено к TITAN CHAT',
        timestamp: Date.now()
    }));
});

function handleJoin(ws, data) {
    const { roomId, userId, nick, avatar } = data;
    
    if (!roomId || !userId) return;
    
    // Создаем комнату если нет
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
    }
    
    const room = rooms.get(roomId);
    
    // Сохраняем клиента
    clients.set(ws, { roomId, userId, nick, avatar });
    room.set(userId, { ws, nick, avatar });
    
    // Отправляем список участников новому
    const users = Array.from(room.values()).map(user => ({
        userId: user.ws === ws ? userId : user.userId,
        nick: user.nick,
        avatar: user.avatar
    }));
    
    ws.send(JSON.stringify({
        type: 'room_joined',
        roomId,
        userId,
        users,
        timestamp: Date.now()
    }));
    
    // Уведомляем других в комнате
    room.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: 'user_joined',
                userId,
                nick,
                avatar,
                timestamp: Date.now()
            }));
        }
    });
    
    console.log(`👤 ${nick} вошел в комнату ${roomId}`);
}

function handleSignal(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { to, signal } = data;
    const room = rooms.get(client.roomId);
    if (!room) return;
    
    const targetUser = room.get(to);
    if (targetUser && targetUser.ws.readyState === 1) {
        targetUser.ws.send(JSON.stringify({
            type: 'signal',
            from: client.userId,
            signal,
            timestamp: Date.now()
        }));
    }
}

function handleMessage(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { message } = data;
    const room = rooms.get(client.roomId);
    if (!room) return;
    
    // Рассылаем сообщение всем в комнате
    room.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: 'chat_message',
                from: client.userId,
                fromNick: client.nick,
                message,
                timestamp: Date.now()
            }));
        }
    });
}

function handleLeave(ws) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { roomId, userId } = client;
    const room = rooms.get(roomId);
    
    if (room) {
        room.delete(userId);
        
        // Удаляем комнату если пустая
        if (room.size === 0) {
            rooms.delete(roomId);
        } else {
            // Уведомляем остальных
            room.forEach((user) => {
                if (user.ws.readyState === 1) {
                    user.ws.send(JSON.stringify({
                        type: 'user_left',
                        userId,
                        timestamp: Date.now()
                    }));
                }
            });
        }
    }
    
    clients.delete(ws);
    console.log(`👋 ${userId} вышел из комнаты`);
}

// Периодическая очистка мертвых подключений
setInterval(() => {
    let cleaned = 0;
    rooms.forEach((room, roomId) => {
        room.forEach((user, userId) => {
            if (user.ws.readyState === 3) { // CLOSED
                room.delete(userId);
                clients.delete(user.ws);
                cleaned++;
            }
        });
        if (room.size === 0) {
            rooms.delete(roomId);
        }
    });
    if (cleaned > 0) {
        console.log(`🧹 Очищено ${cleaned} мертвых подключений`);
    }
}, 30000);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM, завершаем работу...');
    wss.close(() => {
        server.close(() => {
            console.log('✅ Сервер выключен');
            process.exit(0);
        });
    });
});