'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;

    try {
        fs.appendFileSync(SERVER_LOG, line);
    } catch {}

    console.log(line.trim());
}

function defaultConfig() {
    return {
        name: 'ZenX Server',
        botDirectory: process.env.BOT_DIRECTORY || 'apps/zenx-bot',
        repository: process.env.BOT_REPOSITORY || '',
        branch: process.env.BOT_BRANCH || 'main',
        startCommand: process.env.BOT_START_COMMAND || 'npm start',
        autoDeploy: true,
        autoRestart: true
    };
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            const config = defaultConfig();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
            return config;
        }

        return {
            ...defaultConfig(),
            ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
        };
    } catch (error) {
        writeLog(`Config error: ${error.message}`);
        return defaultConfig();
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

let botProcess = null;
let botStarting = false;
let intentionalStop = false;
let restartTimer = null;
let deploymentRunning = false;

function botPath() {
    return path.resolve(ROOT, config.botDirectory);
}

function runCommand(command, args, cwd = ROOT, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                ...extraEnv,
                GIT_TERMINAL_PROMPT: '0'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', data => {
            stdout += data.toString();
        });

        child.stderr.on('data', data => {
            stderr += data.toString();
        });

        child.on('error', reject);

        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const error = new Error(
                    `${command} exited with code ${code}\n${stderr || stdout}`
                );

                error.code = code;
                reject(error);
            }
        });
    });
}

function gitEnv() {
    const env = {};

    if (process.env.GITHUB_TOKEN) {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'http.extraheader';
        env.GIT_CONFIG_VALUE_0 =
            `Authorization: Bearer ${process.env.GITHUB_TOKEN}`;
    }

    return env;
}

function appendBotLog(text) {
    try {
        fs.appendFileSync(
            path.join(LOG_DIR, 'bot.log'),
            text
        );
    } catch {}
}

async function startBot() {
    if (botProcess) {
        return {
            ok: true,
            message: 'Bot is already running'
        };
    }

    if (botStarting) {
        return {
            ok: false,
            message: 'Bot is already starting'
        };
    }

    const directory = botPath();

    if (!fs.existsSync(directory)) {
        throw new Error(`Bot directory does not exist: ${directory}`);
    }

    botStarting = true;
    intentionalStop = false;

    writeLog(`Starting bot: ${config.startCommand}`);

    const childEnv = {
        /*
         * The bot receives its own internal port.
         * This prevents it from fighting the management server
         * for FeatherPanel's public PORT.
         */
        PORT: process.env.BOT_PORT || '3001'
    };

    botProcess = spawn(config.startCommand, {
        cwd: directory,
        env: {
            ...process.env,
            ...childEnv
        },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    botProcess.stdout.on('data', data => {
        const text = data.toString();
        process.stdout.write(`[BOT] ${text}`);
        appendBotLog(text);
    });

    botProcess.stderr.on('data', data => {
        const text = data.toString();
        process.stderr.write(`[BOT] ${text}`);
        appendBotLog(text);
    });

    botProcess.on('error', error => {
        writeLog(`Bot process error: ${error.message}`);
    });

    botProcess.on('close', (code, signal) => {
        const oldPid = botProcess?.pid;

        botProcess = null;
        botStarting = false;

        writeLog(
            `Bot stopped. pid=${oldPid || 'unknown'} code=${code} signal=${signal || 'none'}`
        );

        if (
            !intentionalStop &&
            config.autoRestart &&
            !restartTimer
        ) {
            writeLog('Auto-restart scheduled in 5 seconds.');

            restartTimer = setTimeout(async () => {
                restartTimer = null;

                try {
                    await startBot();
                } catch (error) {
                    writeLog(`Auto-restart failed: ${error.message}`);
                }
            }, 5000);
        }
    });

    botStarting = false;

    return {
        ok: true,
        message: 'Bot started',
        pid: botProcess.pid
    };
}

async function stopBot() {
    if (!botProcess) {
        return {
            ok: true,
            message: 'Bot is not running'
        };
    }

    intentionalStop = true;

    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    const child = botProcess;

    writeLog(`Stopping bot pid=${child.pid}`);

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {}

            resolve({
                ok: true,
                message: 'Bot force-stopped'
            });
        }, 10000);

        child.once('close', () => {
            clearTimeout(timeout);

            resolve({
                ok: true,
                message: 'Bot stopped'
            });
        });

        try {
            child.kill('SIGTERM');
        } catch {
            clearTimeout(timeout);

            resolve({
                ok: true,
                message: 'Bot stopped'
            });
        }
    });
}

async function restartBot() {
    await stopBot();

    await new Promise(resolve => setTimeout(resolve, 1000));

    return startBot();
}

async function deployBot() {
    if (deploymentRunning) {
        throw new Error('A deployment is already running');
    }

    if (!config.repository) {
        throw new Error('No bot repository configured');
    }

    deploymentRunning = true;

    try {
        const directory = botPath();

        writeLog(`Deployment started for ${config.repository}`);

        await stopBot();

        if (!fs.existsSync(directory)) {
            fs.mkdirSync(path.dirname(directory), {
                recursive: true
            });

            writeLog('Cloning bot repository...');

            await runCommand(
                'git',
                [
                    'clone',
                    '--branch',
                    config.branch,
                    config.repository,
                    directory
                ],
                ROOT,
                gitEnv()
            );
        } else {
            if (!fs.existsSync(path.join(directory, '.git'))) {
                throw new Error(
                    `${directory} exists but is not a Git repository`
                );
            }

            writeLog('Updating bot repository...');

            await runCommand(
                'git',
                ['fetch', 'origin', config.branch],
                directory,
                gitEnv()
            );

            await runCommand(
                'git',
                ['reset', '--hard', `origin/${config.branch}`],
                directory,
                gitEnv()
            );
        }

        writeLog('Installing bot dependencies...');

        if (fs.existsSync(path.join(directory, 'package-lock.json'))) {
            await runCommand(
                'npm',
                ['ci'],
                directory
            );
        } else {
            await runCommand(
                'npm',
                ['install'],
                directory
            );
        }

        writeLog('Deployment completed.');

        return {
            ok: true,
            message: 'Deployment completed'
        };
    } finally {
        deploymentRunning = false;
    }
}

function readCgroupMemory() {
    const candidates = [
        ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
        [
            '/sys/fs/cgroup/memory/memory.usage_in_bytes',
            '/sys/fs/cgroup/memory/memory.limit_in_bytes'
        ]
    ];

    for (const [usageFile, limitFile] of candidates) {
        try {
            if (!fs.existsSync(usageFile)) continue;

            const usageText = fs.readFileSync(
                usageFile,
                'utf8'
            ).trim();

            const limitText = fs.readFileSync(
                limitFile,
                'utf8'
            ).trim();

            const usage = Number(usageText);

            if (!Number.isFinite(usage)) continue;

            let limit = Number(limitText);

            if (
                limitText === 'max' ||
                !Number.isFinite(limit) ||
                limit <= 0
            ) {
                limit = os.totalmem();
            }

            return {
                used: usage,
                limit
            };
        } catch {}
    }

    return {
        used: process.memoryUsage().rss,
        limit: os.totalmem()
    };
}

function readDisk() {
    try {
        const output = execFileSync(
            'df',
            ['-kP', ROOT],
            { encoding: 'utf8' }
        );

        const lines = output.trim().split('\n');

        if (lines.length >= 2) {
            const parts = lines[lines.length - 1]
                .trim()
                .split(/\s+/);

            const total = Number(parts[1]) * 1024;
            const used = Number(parts[2]) * 1024;

            if (
                Number.isFinite(total) &&
                Number.isFinite(used)
            ) {
                return {
                    used,
                    total
                };
            }
        }
    } catch {}

    return {
        used: 0,
        total: 0
    };
}

function getResources() {
    const memory = readCgroupMemory();
    const disk = readDisk();

    return {
        memory: {
            usedBytes: memory.used,
            limitBytes: memory.limit,
            usedPercent: memory.limit
                ? Number(
                    ((memory.used / memory.limit) * 100)
                    .toFixed(2)
                )
                : 0
        },

        cpu: {
            loadAverage: os.loadavg(),
            cores: os.cpus().length
        },

        disk: {
            usedBytes: disk.used,
            totalBytes: disk.total,
            usedPercent: disk.total
                ? Number(
                    ((disk.used / disk.total) * 100)
                    .toFixed(2)
                )
                : 0
        }
    };
}

function getStatus() {
    return {
        service: {
            online: true,
            uptime: process.uptime(),
            pid: process.pid
        },

        bot: {
            running: Boolean(botProcess),
            starting: botStarting,
            pid: botProcess?.pid || null,
            deploymentRunning
        },

        resources: getResources(),

        config: {
            name: config.name,
            repository: config.repository,
            branch: config.branch,
            botDirectory: config.botDirectory,
            startCommand: config.startCommand,
            autoDeploy: config.autoDeploy,
            autoRestart: config.autoRestart
        },

        timestamp: new Date().toISOString()
    };
}

function requirePanelKey(req, res, next) {
    const configuredKey = process.env.PANEL_KEY;

    if (!configuredKey) {
        return res.status(503).json({
            error: 'PANEL_KEY is not configured'
        });
    }

    const suppliedKey =
        req.get('X-Panel-Key') ||
        req.query.key ||
        '';

    const supplied = Buffer.from(String(suppliedKey));
    const expected = Buffer.from(String(configuredKey));

    if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)
    ) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    next();
}

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'ZenX Server',
        timestamp: new Date().toISOString()
    });
});

app.post(
    '/webhooks/github',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const secret = process.env.WEBHOOK_SECRET;

        if (!secret) {
            return res.status(503).json({
                error: 'WEBHOOK_SECRET is not configured'
            });
        }

        const signature = req.get('X-Hub-Signature-256');

        if (!signature) {
            return res.status(401).json({
                error: 'Missing GitHub signature'
            });
        }

        const body = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from('');

        const expected =
            'sha256=' +
            crypto
                .createHmac('sha256', secret)
                .update(body)
                .digest('hex');

        const a = Buffer.from(signature);
        const b = Buffer.from(expected);

        if (
            a.length !== b.length ||
            !crypto.timingSafeEqual(a, b)
        ) {
            return res.status(401).json({
                error: 'Invalid GitHub signature'
            });
        }

        let payload;

        try {
            payload = JSON.parse(body.toString('utf8'));
        } catch {
            return res.status(400).json({
                error: 'Invalid JSON'
            });
        }

        const expectedRef =
            `refs/heads/${config.branch}`;

        if (payload.ref !== expectedRef) {
            return res.json({
                ok: true,
                ignored: true,
                reason: 'Branch does not match configured branch'
            });
        }

        if (
            config.autoDeploy &&
            !deploymentRunning
        ) {
            deployBot()
                .then(() => startBot())
                .then(() => {
                    writeLog('GitHub deployment finished successfully.');
                })
                .catch(error => {
                    writeLog(
                        `GitHub deployment failed: ${error.message}`
                    );
                });
        }

        res.status(202).json({
            ok: true,
            message: 'GitHub deployment accepted'
        });
    }
);

app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(ROOT, 'public')));

app.post('/api/auth', (req, res) => {
    const configuredKey = process.env.PANEL_KEY || '';
    const suppliedKey = String(req.body?.key || '');

    const a = Buffer.from(suppliedKey);
    const b = Buffer.from(configuredKey);

    if (
        configuredKey &&
        a.length === b.length &&
        crypto.timingSafeEqual(a, b)
    ) {
        return res.json({
            ok: true
        });
    }

    res.status(401).json({
        ok: false,
        error: 'Invalid panel key'
    });
});

app.use('/api', requirePanelKey);

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.get('/api/config', (req, res) => {
    res.json({
        ...config
    });
});

app.put('/api/config', (req, res) => {
    const allowed = [
        'name',
        'botDirectory',
        'repository',
        'branch',
        'startCommand',
        'autoDeploy',
        'autoRestart'
    ];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            config[key] = req.body[key];
        }
    }

    saveConfig(config);

    writeLog('Server configuration updated.');

    res.json({
        ok: true,
        config
    });
});

app.get('/api/logs', (req, res) => {
    const type = req.query.type === 'server'
        ? 'server.log'
        : 'bot.log';

    const file = path.join(LOG_DIR, type);

    if (!fs.existsSync(file)) {
        return res.json({
            logs: ''
        });
    }

    const content = fs.readFileSync(
        file,
        'utf8'
    );

    res.json({
        logs: content.slice(-100000)
    });
});

app.post('/api/server/start', async (req, res) => {
    try {
        res.json(await startBot());
    } catch (error) {
        writeLog(`Start failed: ${error.message}`);

        res.status(500).json({
            error: error.message
        });
    }
});

app.post('/api/server/stop', async (req, res) => {
    try {
        res.json(await stopBot());
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

app.post('/api/server/restart', async (req, res) => {
    try {
        res.json(await restartBot());
    } catch (error) {
        writeLog(`Restart failed: ${error.message}`);

        res.status(500).json({
            error: error.message
        });
    }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const result = await deployBot();

        await startBot();

        res.json(result);
    } catch (error) {
        writeLog(`Deployment failed: ${error.message}`);

        res.status(500).json({
            error: error.message
        });
    }
});

app.get('/api/github', (req, res) => {
    res.json({
        repository: config.repository,
        branch: config.branch,
        webhookPath: '/webhooks/github',
        webhookConfigured: Boolean(
            process.env.WEBHOOK_SECRET
        ),
        tokenConfigured: Boolean(
            process.env.GITHUB_TOKEN
        )
    });
});

app.get('*', (req, res) => {
    res.sendFile(
        path.join(ROOT, 'public', 'index.html')
    );
});

const server = app.listen(PORT, HOST, () => {
    writeLog(
        `ZenX Server listening on ${HOST}:${PORT}`
    );
});

async function shutdown(signal) {
    writeLog(`Received ${signal}. Shutting down.`);

    intentionalStop = true;

    try {
        await stopBot();
    } catch {}

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', error => {
    writeLog(`Uncaught exception: ${error.stack || error.message}`);
});

process.on('unhandledRejection', error => {
    writeLog(
        `Unhandled rejection: ${
            error?.stack || error
        }`
    );
});
