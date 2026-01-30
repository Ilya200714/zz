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
});

// WebSocket сервер
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws, req) => {
    console.log('🔗 Новое подключение');
    
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
                case 'chat':
                    handleChat(ws, data);
                    break;
                case 'action':
                    handleAction(ws, data);
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка:', error.message);
        }
    });
    
    ws.on('close', () => {
        handleDisconnect(ws);
        console.log('🔌 Отключился');
    });
});

function handleJoin(ws, data) {
    const { roomId, userId, nick, avatar } = data;
    
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
    }
    
    const room = rooms.get(roomId);
    
    // Сохраняем клиента
    clients.set(ws, { roomId, userId, nick, avatar });
    room.set(userId, { ws, nick, avatar });
    
    // Отправляем список участников новичку
    const usersInRoom = Array.from(room.entries())
        .filter(([id]) => id !== userId)
        .map(([id, user]) => ({
            userId: id,
            nick: user.nick,
            avatar: user.avatar
        }));
    
    ws.send(JSON.stringify({
        type: 'joined',
        roomId,
        yourId: userId,
        users: usersInRoom
    }));
    
    // Уведомляем других о новом пользователе
    room.forEach((user, id) => {
        if (id !== userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: 'user-joined',
                userId,
                nick,
                avatar
            }));
        }
    });
    
    console.log(`👤 ${nick} вошёл в комнату ${roomId}`);
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
            signal: signal
        }));
    }
}

function handleChat(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { message } = data;
    const room = rooms.get(client.roomId);
    if (!room) return;
    
    // Рассылаем всем в комнате
    room.forEach((user) => {
        if (user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: 'chat',
                from: client.userId,
                fromNick: client.nick,
                message,
                timestamp: Date.now()
            }));
        }
    });
}

function handleAction(ws, data) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { action, value } = data;
    const room = rooms.get(client.roomId);
    if (!room) return;
    
    // Рассылаем всем кроме отправителя
    room.forEach((user, userId) => {
        if (userId !== client.userId && user.ws.readyState === 1) {
            user.ws.send(JSON.stringify({
                type: 'action',
                from: client.userId,
                action,
                value,
                timestamp: Date.now()
            }));
        }
    });
}

function handleDisconnect(ws) {
    const client = clients.get(ws);
    if (!client) return;
    
    const { roomId, userId } = client;
    const room = rooms.get(roomId);
    
    if (room) {
        room.delete(userId);
        
        if (room.size === 0) {
            rooms.delete(roomId);
        } else {
            // Уведомляем остальных
            room.forEach((user) => {
                if (user.ws.readyState === 1) {
                    user.ws.send(JSON.stringify({
                        type: 'user-left',
                        userId
                    }));
                }
            });
        }
    }
    
    clients.delete(ws);
    console.log(`👋 ${userId} вышел`);
}