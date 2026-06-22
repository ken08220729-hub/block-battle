const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 遊戲狀態與實體
let gameState = {
    status: 'waiting', // waiting, naming, playing, ended
    winnerName: '',
    players: {
        1: { id: null, name: '', hp: 200, maxHp: 200, shield: 0, gold: 0, tier: 1, cooldownUntil: 0, blockedUntil: 0, machineGuns: 0 },
        2: { id: null, name: '', hp: 200, maxHp: 200, shield: 0, gold: 0, tier: 1, cooldownUntil: 0, blockedUntil: 0, machineGuns: 0 }
    },
    entities: {
        projectiles: [],
        minions: []
    }
};

let mgTick = 0;
let nextEntityId = 1;

// 機率表
const lootTables = {
    1: [
        { chance: 60, type: 'gold', val: 1 },
        { chance: 25, type: 'knife', val: 1 },
        { chance: 10, type: 'bomb', val: 1 },
        { chance: 5, type: 'upgrade', val: 1 }
    ],
    2: [
        { chance: 60, type: 'gold', val: 3 },
        { chance: 15, type: 'knife', val: 3 },
        { chance: 10, type: 'shield', val: 10 },
        { chance: 10, type: 'summon', val: 4 },
        { chance: 5, type: 'upgrade', val: 1 }
    ],
    3: [
        { chance: 20, type: 'gold', val: 8 },
        { chance: 25, type: 'knife', val: 7 },
        { chance: 15, type: 'nuke', val: 1 },
        { chance: 15, type: 'summon', val: 15 },
        { chance: 10, type: 'shield', val: 50 },
        { chance: 4.9, type: 'block', val: 3 },
        { chance: 10, type: 'heal', val: 0.1 },
        { chance: 1, type: 'mg', val: 1 }
    ]
};

function getSlotById(id) {
    if (gameState.players[1].id === id) return 1;
    if (gameState.players[2].id === id) return 2;
    return null;
}

function resetGame() {
    gameState.status = 'naming';
    gameState.winnerName = '';
    gameState.entities.projectiles = [];
    gameState.entities.minions = [];
    [1, 2].forEach(slot => {
        gameState.players[slot].name = '';
        gameState.players[slot].hp = 200;
        gameState.players[slot].maxHp = 200;
        gameState.players[slot].shield = 0;
        gameState.players[slot].gold = 0;
        gameState.players[slot].tier = 1;
        gameState.players[slot].cooldownUntil = 0;
        gameState.players[slot].blockedUntil = 0;
        gameState.players[slot].machineGuns = 0;
    });
}

function applyDamage(slot, amount, ignoreShield = false, isNuke = false) {
    let p = gameState.players[slot];
    if (isNuke) {
        p.shield = 0;
        p.hp -= amount;
    } else {
        if (!ignoreShield && p.shield > 0) {
            p.shield -= amount;
            if (p.shield < 0) {
                p.hp += p.shield; // 溢出傷害
                p.shield = 0;
            }
        } else {
            p.hp -= amount;
        }
    }
    if (p.hp <= 0 && gameState.status === 'playing') {
        p.hp = 0;
        gameState.status = 'ended';
        gameState.winnerName = gameState.players[slot === 1 ? 2 : 1].name;
        io.emit('gameOver', gameState.winnerName);
        setTimeout(resetGame, 5000);
    }
}

// 物理與遊戲邏輯迴圈 (30 FPS = 每 33.3ms 執行一次)
setInterval(() => {
    if (gameState.status !== 'playing') return;
    const dt = 1 / 30;

    // 更新機槍 (每 0.33秒 = 10 ticks)
    mgTick++;
    if (mgTick >= 10) {
        mgTick = 0;
        if (gameState.players[1].machineGuns > 0) applyDamage(2, gameState.players[1].machineGuns);
        if (gameState.players[2].machineGuns > 0) applyDamage(1, gameState.players[2].machineGuns);
    }

    // 更新小人
    gameState.entities.minions.forEach(m => {
        const targetX = m.owner === 1 ? 150 : 0;
        if (Math.abs(m.x - targetX) > 1) { // 移動速度 50
            m.x += (m.owner === 1 ? 1 : -1) * 50 * dt;
        } else {
            // 抵達城堡開始攻擊
            m.lastAttack += dt;
            if (m.lastAttack >= 1.5) {
                m.lastAttack = 0;
                applyDamage(m.owner === 1 ? 2 : 1, 1);
            }
        }
    });

    // 更新投射物
    for (let i = gameState.entities.projectiles.length - 1; i >= 0; i--) {
        let p = gameState.entities.projectiles[i];
        p.x += (p.owner === 1 ? 1 : -1) * p.speed * dt;
        let hit = false;
        const targetSlot = p.owner === 1 ? 2 : 1;
        const targetX = p.owner === 1 ? 150 : 0;

        // 飛刀判定：碰到敵方小人
        if (p.type === 'knife') {
            for (let j = 0; j < gameState.entities.minions.length; j++) {
                let m = gameState.entities.minions[j];
                if (m.owner === targetSlot) {
                    let minionCrossed = p.owner === 1 ? (p.x >= m.x) : (p.x <= m.x);
                    if (minionCrossed) {
                        gameState.entities.minions.splice(j, 1); // 擊殺小人
                        hit = true;
                        break;
                    }
                }
            }
        }

        // 抵達城堡判定
        let reachedCastle = p.owner === 1 ? (p.x >= 150) : (p.x <= 0);
        if (!hit && reachedCastle) {
            hit = true;
            if (p.type === 'knife') applyDamage(targetSlot, 1);
            else if (p.type === 'bomb') applyDamage(targetSlot, 5);
            else if (p.type === 'nuke') {
                applyDamage(targetSlot, 30, true, true);
                gameState.entities.minions = gameState.entities.minions.filter(m => m.owner === p.owner); // 殺光敵方小人
            }
        }

        if (hit) {
            gameState.entities.projectiles.splice(i, 1);
        }
    }

    io.emit('stateUpdate', gameState);
}, 33.3);

// Socket 連線處理
io.on('connection', (socket) => {
    let slot = null;
    if (!gameState.players[1].id) slot = 1;
    else if (!gameState.players[2].id) slot = 2;

    if (slot) {
        gameState.players[slot].id = socket.id;
        socket.emit('init', { slot: slot, state: gameState });
        if (gameState.players[1].id && gameState.players[2].id && gameState.status === 'waiting') {
            gameState.status = 'naming';
        }
    } else {
        socket.emit('full'); // 暫時滿人
        return;
    }
    
    io.emit('stateUpdate', gameState);

    socket.on('setName', (name) => {
        if (gameState.status === 'naming' && slot) {
            gameState.players[slot].name = name.substring(0, 10);
            if (gameState.players[1].name && gameState.players[2].name) {
                gameState.status = 'playing';
            }
        }
    });

    socket.on('hitBlock', () => {
        if (gameState.status !== 'playing' || !slot) return;
        const p = gameState.players[slot];
        const now = Date.now();

        if (now < p.cooldownUntil || now < p.blockedUntil) return;

        // 設定冷卻
        p.cooldownUntil = now + (p.tier === 3 ? 1000 : 3000);

        // 抽獎機率
        let totalWeight = lootTables[p.tier].reduce((sum, item) => sum + item.chance, 0);
        let roll = Math.random() * totalWeight;
        let selected = null;
        for (let item of lootTables[p.tier]) {
            if (roll < item.chance) { selected = item; break; }
            roll -= item.chance;
        }

        // 處理獎項
        if (selected.type === 'gold') p.gold += selected.val;
        if (selected.type === 'upgrade' && p.tier < 3) p.tier++;
        if (selected.type === 'shield') p.shield = (selected.val === 50) ? 50 : 10;
        if (selected.type === 'block') gameState.players[slot === 1 ? 2 : 1].blockedUntil = now + 3000;
        if (selected.type === 'heal') {
            p.hp = Math.min(p.maxHp, p.hp + (p.maxHp * selected.val));
        }
        if (selected.type === 'mg') p.machineGuns += selected.val;
        
        // 投射物
        if (['knife', 'bomb', 'nuke'].includes(selected.type)) {
            for (let i = 0; i < selected.val; i++) {
                let speed = selected.type === 'knife' ? 200 : (selected.type === 'bomb' ? 30 : 45);
                setTimeout(() => {
                    gameState.entities.projectiles.push({ id: nextEntityId++, type: selected.type, x: slot === 1 ? 0 : 150, speed: speed, owner: slot });
                }, i * 100);
            }
        }

        // 召喚小人 (在0.3秒內平均召喚)
        if (selected.type === 'summon') {
            const interval = 300 / selected.val;
            for (let i = 0; i < selected.val; i++) {
                setTimeout(() => {
                    gameState.entities.minions.push({ id: nextEntityId++, owner: slot, x: slot === 1 ? 0 : 150, lastAttack: 0 });
                }, i * interval);
            }
        }
    });

    socket.on('buyUpgrade', (type) => {
        if (gameState.status !== 'playing' || !slot) return;
        const p = gameState.players[slot];
        if (type === 'hp' && p.gold >= 20) {
            p.gold -= 20;
            p.maxHp += 50;
            p.hp += 50;
        } else if (type === 'minion' && p.gold >= 2) {
            p.gold -= 2;
            gameState.entities.minions.push({ id: nextEntityId++, owner: slot, x: slot === 1 ? 0 : 150, lastAttack: 0 });
        }
    });

    socket.on('disconnect', () => {
        if (slot) {
            gameState.players[slot].id = null;
            gameState.status = 'waiting';
            resetGame();
            io.emit('stateUpdate', gameState);
        }
    });
});

server.listen(PORT, () => {
    console.log(`伺服器啟動: http://localhost:${PORT}`);
});
