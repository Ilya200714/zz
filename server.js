const WebSocket = require('ws');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Убираем все ограничения CSP
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "img-src * data: blob:; " +
        "media-src * data: blob:; " +
        "script-src * 'unsafe-inline' 'unsafe-eval'; " +
        "style-src * 'unsafe-inline'; " +
        "font-src * data:; " +
        "connect-src * ws: wss:;"
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// Раздаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запускаем HTTP сервер
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TITAN CHAT запущен на порту ${PORT}`);
    console.log(`👉 URL: http://localhost:${PORT}`);
});

// WebSocket сервер
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true,
    perMessageDeflate: false
});

const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log('🔗 Новое подключение от', ip);
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('❌ Ошибка парсинга:', error.message);
        }
    });
    
    ws.on('close', () => {
        handleDisconnect(ws);
        console.log('🔌 Отключился', ip);
    });
    
    ws.on('error', (error) => {
        console.error('💥 WebSocket ошибка:', error);
    });
    
    // Отправляем подтверждение подключения
    ws.send(JSON.stringify({
        type: 'connected',
        timestamp: Date.now()
    }));
});

function handleMessage(ws, data) {
    console.log('📨 Получено:', data.type, 'от', data.userId || 'unknown');
    
    switch(data.type) {
        case 'join':
            handleJoin(ws, data);
            break;
        case 'webrtc-signal':
            handleWebRTCSignal(ws, data);
            break;
        case 'chat':
            handleChat(ws, data);
            break;
        case 'user-action':
            handleUserAction(ws, data);
            break;
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

function handleJoin(ws, data) {
    const { roomId, userId, nick, avatar } = data;
    
    if (!roomId || !userId) {
        console.error('❌ Нет roomId или userId');
        return;
    }
    
    // Создаем комнату если нет
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
        console.log(`🏠 Создана комната: ${roomId}`);
    }
    
    const room = rooms.get(roomId);
    
    // Проверяем, не подключен ли уже пользователь
    if (room.has(userId)) {
        console.log(`⚠️ Пользователь ${userId} уже в комнате`);
        // Отправляем ошибку
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Пользователь уже подключен'
        }));
        return;
    }
    
    // Сохраняем клиента
    clients.set(ws, { roomId, userId, nick, avatar });
    room.set(userId, { ws, nick, avatar, joinedAt: Date.now() });
    
    // Отправляем подтверждение и список пользователей
    const usersInRoom = Array.from(room.entries()).map(([id, user]) => ({
        userId: id,
        nick: user.nick,
        avatar: user.avatar,
        isSelf: id === userId
    }));
    
    ws.send(JSON.stringify({
        type: 'room-joined',
        roomId,
        yourId: userId,
        users: usersInRoom.filter(u => !u.isSelf),
        timestamp: Date.now()
    }));
    
    // Уведомляем других о новом пользователе (отправляем всем кроме нового)
    room.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(JSON.stringify({
                type: 'user-joined',
                userId,
                nick,
                avatar,
                timestamp: Date.now()
            }));
        }
    });
    
    console.log(`👤 ${nick} (${userId}) вошёл в комнату ${roomId}. Всего в комнате: ${room.size}`);
}

function handleWebRTCSignal(ws, data) {
    const client = clients.get(ws);
    if (!client) {
        console.error('❌ Клиент не найден для WebRTC сигнала');
        return;
    }
    
    const { to, signal } = data;
    const room = rooms.get(client.roomId);
    
    if (!room) {
        console.error(`❌ Комната ${client.roomId} не найдена`);
        return;
    }
    
    const targetUser = room.get(to);
    
    if (!targetUser) {
        console.error(`❌ Целевой пользователь ${to} не найден в комнате`);
        return;
    }
    
    if (targetUser.ws.readyState !== WebSocket.OPEN) {
        console.error(`❌ WebSocket целевого пользователя ${to} не открыт`);
        return;
    }
    
    console.log(`📡 Пересылаю WebRTC сигнал от ${client.userId} к ${to}, тип: ${signal.type}`);
    
    try {
        targetUser.ws.send(JSON.stringify({
            type: 'webrtc-signal',
            from: client.userId,
            signal: signal,
            timestamp: Date.now()
        }));
    } catch (error) {
        console.error('❌ Ошибка отправки WebRTC сигнала:', error);
    }
}

function handleChat(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { message, messageType = 'text' } = data;
    const room = rooms.get(client.roomId);
    
    if (!room) return;
    
    console.log(`💬 Чат от ${client.nick}: ${message.substring(0, 50)}...`);
    
    // Рассылаем всем в комнате
    const messageId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const timestamp = Date.now();
    
    room.forEach((user, userId) => {
        if (user.ws.readyState === WebSocket.OPEN) {
            try {
                user.ws.send(JSON.stringify({
                    type: 'chat',
                    from: client.userId,
                    fromNick: client.nick,
                    message,
                    messageType,
                    messageId,
                    timestamp,
                    isSelf: userId === client.userId
                }));
            } catch (error) {
                console.error(`❌ Ошибка отправки сообщения пользователю ${userId}:`, error);
            }
        }
    });
}

function handleUserAction(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { action, value } = data;
    const room = rooms.get(client.roomId);
    
    if (!room) return;
    
    console.log(`🎮 Действие от ${client.nick}: ${action} = ${value}`);
    
    // Рассылаем всем кроме отправителя
    room.forEach((user, userId) => {
        if (userId !== client.userId && user.ws.readyState === WebSocket.OPEN) {
            try {
                user.ws.send(JSON.stringify({
                    type: 'user-action',
                    from: client.userId,
                    fromNick: client.nick,
                    action,
                    value,
                    timestamp: Date.now()
                }));
            } catch (error) {
                console.error(`❌ Ошибка отправки действия пользователю ${userId}:`, error);
            }
        }
    });
}

function handleDisconnect(ws) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { roomId, userId, nick } = client;
    const room = rooms.get(roomId);
    
    if (room) {
        room.delete(userId);
        
        if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Комната ${roomId} удалена (пустая)`);
        } else {
            // Уведомляем остальных
            room.forEach((user) => {
                if (user.ws.readyState === WebSocket.OPEN) {
                    try {
                        user.ws.send(JSON.stringify({
                            type: 'user-left',
                            userId,
                            nick,
                            timestamp: Date.now()
                        }));
                    } catch (error) {
                        console.error('❌ Ошибка отправки уведомления о выходе:', error);
                    }
                }
            });
        }
    }
    
    clients.delete(ws);
    console.log(`👋 ${nick} (${userId}) вышел из комнаты ${roomId}`);
}

// Пинг для поддержания соединения
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('💀 Мертвое соединение, завершаю...');
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (error) {
            console.error('❌ Ошибка пинга:', error);
        }
    });
}, 30000);

// Очистка мертвых подключений
setInterval(() => {
    let cleaned = 0;
    rooms.forEach((room, roomId) => {
        room.forEach((user, userId) => {
            if (user.ws.readyState === WebSocket.CLOSED || user.ws.readyState === WebSocket.CLOSING) {
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
}, 60000);

process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM, завершаем работу...');
    wss.close(() => {
        server.close(() => {
            console.log('✅ Сервер выключен');
            process.exit(0);
        });
    });
});